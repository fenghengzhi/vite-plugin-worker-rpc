import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build, createServer, preview, type InlineConfig, type PreviewServer } from 'vite'
import workerRpc from '../src/index.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = join(repository, 'tests/fixtures/proxy-architecture')

async function closeHttpServer(server: PreviewServer['httpServer']): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
}

test('dynamic proxy modules preserve import forms without inspecting RPC export declarations', { timeout: 100_000 }, async (t) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  try {
    for (const mode of ['development', 'production'] as const) {
      await t.test(mode, { timeout: 45_000 }, async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-proxy-')))
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        let closeServer: (() => Promise<void>) | undefined
        try {
          await cp(fixtureDirectory, root, { recursive: true })
          const componentId = join(root, 'component.vue')
          const componentScriptId = `${componentId}?vue&type=script&lang.js`
          const config: InlineConfig = {
            root,
            configFile: false,
            logLevel: 'error',
            plugins: [workerRpc({ pool: 1, timeoutMs: 10_000 }), {
              // Emulate a framework plugin that compiles an SFC into a wrapper
              // and a virtual script module; no framework dependency is needed.
              name: 'test-framework-compiler',
              resolveId(source) {
                if (source === componentScriptId) return source
              },
              async load(id) {
                if (id !== componentScriptId) return
                const source = await readFile(componentId, 'utf8')
                const script = source.match(/<script>([\s\S]*?)<\/script>/)
                assert.ok(script)
                return script[1]!
              },
              transform(_code, id) {
                if (id !== componentId) return
                return { code: `export { fromFramework } from ${JSON.stringify(componentScriptId)};`, map: null }
              },
            }],
            resolve: { alias: { '@rpc': join(root, 'compute.rpc.ts') } },
            server: { middlewareMode: true, hmr: false, fs: { allow: [root, repository] } },
            preview: { host: '127.0.0.1', port: 0 },
            build: { target: 'es2022' },
          }
          let url: string
          if (mode === 'development') {
            const http = createHttpServer()
            closeServer = () => closeHttpServer(http)
            const vite = await createServer({
              ...config,
              server: { ...config.server, hmr: { server: http } },
            })
            http.on('request', vite.middlewares)
            closeServer = async () => { await Promise.all([vite.close(), closeHttpServer(http)]) }
            await new Promise<void>((resolve, reject) => {
              http.once('error', reject)
              http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
            })
            const address = http.address()
            assert.ok(address && typeof address === 'object')
            url = `http://127.0.0.1:${address.port}/`
          } else {
            await build(config)
            const server = await preview(config)
            closeServer = () => closeHttpServer(server.httpServer)
            url = server.resolvedUrls!.local[0]!
          }
          await page.addInitScript(() => {
            Object.assign(globalThis, { architectureWorkerCount: 0 })
            const OriginalWorker = globalThis.Worker
            globalThis.Worker = class extends OriginalWorker {
              constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options)
                ;(globalThis as any).architectureWorkerCount += 1
              }
            }
          })
          await page.goto(url)
          await page.waitForFunction(() => Boolean((globalThis as any).architectureApi) && typeof (globalThis as any).inlineHtmlCalculate === 'function', undefined, { timeout: 10_000 })
          assert.equal(await page.evaluate(() => (globalThis as any).architectureApi.namespaces()), true,
            'static/default/re-exported namespace values survive Promise resolution without calling then')
          assert.equal(await page.evaluate(() => (globalThis as any).architectureWorkerCount), 0, 'module imports must remain lazy')
          const result = await page.evaluate(() => (globalThis as any).architectureApi.run())
          assert.deepEqual(result.results.map((value: { value: number }) => value.value), [2, 4, 6, 8, 10, 12])
          assert.equal(new Set(result.results.map((value: { workerId: string }) => value.workerId)).size, 1)
          assert.ok(result.results.every((value: { inWorker: boolean }) => value.inWorker))
          assert.equal(result.otherConsumer.value, 14)
          assert.equal(result.otherConsumer.workerId, result.results[0].workerId)
          assert.equal(result.framework.value, 42)
          assert.equal(result.framework.workerId, result.results[0].workerId, 'framework-generated virtual scripts share the same pool')
          assert.equal(result.inlineHtml.value, 43)
          assert.equal(result.inlineHtml.workerId, result.results[0].workerId)
          assert.equal(result.sharedInlineMethod, true, 'inline HTML module imports share the same cached proxy method')
          assert.deepEqual(result.failure, { name: 'TypeError', message: 'callback failed' })
          assert.deepEqual(result.bindingResults, [
            { value: 11, inWorker: true },
            { value: 22, inWorker: true },
            { value: 33, inWorker: true },
          ])
          assert.equal(result.methodErrors.length, 3)
          assert.ok(result.methodErrors.every((error: { name: string }) => error.name === 'TypeError'))
          assert.deepEqual(result.specialExports, [101, 202, 203, 204])
          assert.equal(result.stableMethods, true)
          assert.equal(result.sharedMethods, true, 'all import forms should resolve to the same cached proxy method')
          assert.equal(await page.evaluate(() => (globalThis as any).architectureWorkerCount), 1, 'aliases, query defaults, and reexports share a pool; nested RPC stays local')
          assert.deepEqual(errors, [], 'RPC implementations and their dependencies must never evaluate on the main thread')
        } finally {
          await page.close()
          await closeServer?.()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  } finally {
    await browser.close()
  }
})
