import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFilter, type FilterPattern } from '@rollup/pluginutils'
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite'
import { collectRpcExports } from './exports.js'
import { parsePoolQuery, poolModuleId } from './pool-query.js'
import type { RpcPoolMode } from './runtime.js'

export type { RpcPoolMode } from './runtime.js'
export type { Remote } from './remote.js'

export interface WorkerRpcOptions {
  /** Modules to transform. Defaults to files ending in .rpc.ts, .rpc.js, .rpc.mts or .rpc.mjs. */
  include?: FilterPattern
  /** Modules to leave unchanged. Defaults to node_modules. */
  exclude?: FilterPattern
  /** Default pool mode for imports without ?pool. Defaults to auto. Each module has its own pool. */
  pool?: RpcPoolMode
  /** Per-call deadline in milliseconds. 0 (the default) disables it. */
  timeoutMs?: number
}

const sourceFlag = 'worker-rpc-source'
const scriptPattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const cleanId = (id: string) => id.split('?', 1)[0]!
const isSource = (id: string) => new URLSearchParams(id.split('?')[1]).has(sourceFlag)
const sourceId = (id: string) => `${id}${id.includes('?') ? '&' : '?'}${sourceFlag}`
const jsString = (value: string) => JSON.stringify(value)
function importPath(from: string, to: string): string {
  const path = normalizePath(relative(dirname(from), to))
  return path.startsWith('.') ? path : `./${path}`
}

/** Turn named function imports from *.rpc.ts / *.rpc.js into lazy Worker calls. */
export default function workerRpc(options: WorkerRpcOptions = {}): Plugin {
  return createPlugin(options, false)
}

function createPlugin(options: WorkerRpcOptions, workerBuild: boolean): Plugin {
  let matches: ReturnType<typeof createFilter>
  const defaultPool = options.pool === undefined ? 'auto' : options.pool
  if (defaultPool !== 'auto' && defaultPool !== 'unlimited' &&
      !(typeof defaultPool === 'number' && Number.isSafeInteger(defaultPool) && defaultPool > 0)) {
    throw new TypeError('[vite-plugin-worker-rpc] pool must be a positive safe integer, "auto", or "unlimited".')
  }
  const timeoutMs = options.timeoutMs ?? 0
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('[vite-plugin-worker-rpc] timeoutMs must be an integer between 0 and 2147483647.')
  }
  let config: ResolvedConfig
  const workerFiles = new Set<string>()
  const runtimeJs = fileURLToPath(new URL('./runtime.js', import.meta.url))
  const runtime = realpathSync(existsSync(runtimeJs) ? runtimeJs : fileURLToPath(new URL('./runtime.ts', import.meta.url)))
  async function cacheDirectory(): Promise<string> {
    const cache = resolve(config.cacheDir, 'worker-rpc')
    await mkdir(cache, { recursive: true })
    // Vite resolves Worker entries through realpath. Relative imports must use
    // the same canonical directory, especially for macOS /var -> /private/var.
    return realpath(cache)
  }

  return {
    name: 'vite-plugin-worker-rpc',
    enforce: 'pre',
    config(userConfig) {
      if (workerBuild) return
      const existingPlugins = userConfig.worker?.plugins
      return {
        // Public helpers and generated clients must share Comlink's transfer
        // handlers/markers instead of embedding separate optimized copies.
        optimizeDeps: { exclude: ['vite-plugin-worker-rpc/client', 'vite-plugin-worker-rpc/runtime', 'comlink'] },
        worker: {
          // Worker builds have a separate plugin pipeline. Use a fresh instance
          // to normalize nested RPC queries while preserving user Worker plugins.
          plugins: () => [createPlugin(options, true), ...(existingPlugins?.() ?? [])],
        },
      }
    },
    configResolved(resolved) {
      config = resolved
      matches = createFilter(
        options.include ?? '**/*.rpc.{ts,js,mts,mjs}',
        options.exclude ?? '**/node_modules/**',
        { resolve: resolved.root },
      )
    },
    async configureServer(server) {
      // cacheDir may live outside root (for example in a monorepo). Only grant
      // access to our generated entries; retain Vite's existing allow list.
      const entries = normalizePath(await cacheDirectory())
      if (!server.config.server.fs.allow.includes(entries)) server.config.server.fs.allow.push(entries)
    },
    async resolveId(source, importer, resolveOptions) {
      if (source.startsWith('\0')) return
      let resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true })
      // Vite's exact string aliases do not match when a query is appended.
      // Resolve the path on its own only as a fallback for our owned query,
      // retaining other plugins' normal handling of non-RPC requests.
      if (!resolved && new URLSearchParams(source.split('?')[1]).has('pool')) {
        const path = await this.resolve(cleanId(source), importer, { ...resolveOptions, skipSelf: true })
        if (path && !path.external && matches(cleanId(path.id))) {
          if (isSource(path.id)) {
            // Resolving a nested alias may already select its local Worker
            // implementation. Validate the query without adding a second ID
            // for the same implementation and splitting its module state.
            parsePoolQuery(source)
            resolved = path
          } else {
            resolved = { ...path, id: `${path.id}${path.id.includes('?') ? '&' : '?'}${source.slice(source.indexOf('?') + 1)}` }
          }
        }
      }
      if (!resolved || resolved.external || !isAbsolute(cleanId(resolved.id))) return resolved
      const filename = cleanId(resolved.id)

      if (config.isWorker) {
        if (isSource(resolved.id) || (matches(filename) && parsePoolQuery(resolved.id) !== null)) {
          return { ...resolved, id: normalizePath(await realpath(filename)) }
        }
        return resolved
      }

      // Keep the entire local dependency graph in the Worker, including RPC
      // modules imported indirectly through helpers. Bare packages keep Vite's
      // normal dependency optimization and resolution behavior.
      if (isSource(resolved.id)) return resolved
      if (importer && isSource(importer)) {
        if (filename.includes('/node_modules/') || !scriptPattern.test(filename)) return resolved
        if (resolved.id.includes('?')) {
          // A pool option describes a browser boundary. Inside an existing
          // Worker the imported implementation is a normal local dependency.
          if (!matches(filename) || parsePoolQuery(resolved.id) === null) return resolved
        }
        workerFiles.add(normalizePath(filename))
        return { ...resolved, id: sourceId(filename) }
      }
      if (!matches(filename)) return resolved
      const pool = parsePoolQuery(resolved.id, defaultPool)
      if (pool === null) return resolved
      return { ...resolved, id: poolModuleId(normalizePath(await realpath(filename)), pool, defaultPool) }
    },
    async transform(code, id) {
      let filename = cleanId(id)
      if (isSource(id)) {
        workerFiles.add(normalizePath(filename))
        return
      }
      if (!matches(filename) || config.isWorker) return
      const pool = parsePoolQuery(id, defaultPool)
      if (pool === null) return
      const names = collectRpcExports(code, filename)
      if (!names.length) return { code: 'export {};', map: null }
      filename = await realpath(filename)
      const cache = await cacheDirectory()
      const hash = createHash('sha256').update(normalizePath(filename)).digest('hex').slice(0, 20)
      const entry = resolve(cache, `${hash}.mjs`)
      const workerCode = [
        `import { exposeRpc } from ${jsString(importPath(entry, runtime))};`,
        `import * as api from ${jsString(sourceId(importPath(entry, filename)))};`,
        'exposeRpc(api);',
      ].join('\n')
      if (await readFile(entry, 'utf8').catch(() => '') !== workerCode) await writeFile(entry, workerCode)
      this.addWatchFile(filename)
      workerFiles.add(normalizePath(filename))
      return {
        code: [
          `import { createRpcClient } from ${jsString(normalizePath(runtime))};`,
          'const rpc = createRpcClient(() => {',
          '  if (typeof Worker === "undefined") throw new Error("[vite-plugin-worker-rpc] RPC calls require a browser with Web Worker support. Calls during SSR are not supported.");',
          `  return new Worker(new URL(${jsString(importPath(filename, entry))}, import.meta.url), { type: "module" });`,
          `}, { timeoutMs: ${timeoutMs}, pool: ${JSON.stringify(pool)} });`,
          ...names.map((name, index) => `const call${index} = (...args) => rpc.call(${jsString(name)}, args);\nexport { call${index} as ${jsString(name)} };`),
          'if (import.meta.hot) import.meta.hot.dispose(() => rpc.dispose());',
        ].join('\n'),
        map: null,
      }
    },
    handleHotUpdate(context) {
      // Workers cannot accept regular module HMR. Reload to replace their whole
      // module graph and avoid retaining old state or old function proxies.
      if (workerFiles.has(normalizePath(context.file))) {
        for (const module of context.modules) context.server.moduleGraph.invalidateModule(module)
        context.server.ws.send({ type: 'full-reload', path: '*' })
        return []
      }
    },
  }
}
