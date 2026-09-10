import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { build, createServer, preview } from 'vite'
import { chromium } from 'playwright'
import workerRpc from '../src/index.js'

test('pool resolution preserves native asset queries and canonicalizes symlink imports', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-rpc-pool-review-')))
  const rpc = join(root, 'compute.rpc.ts')
  await writeFile(rpc, 'export function add(a: number, b: number) { return a + b }')
  await writeFile(join(root, 'main.ts'), 'import { add } from "@rpc"; globalThis.add = add;')
  await symlink(rpc, join(root, 'linked.rpc.ts'))
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [workerRpc()],
    resolve: { preserveSymlinks: true, alias: { '@rpc': rpc } },
    server: { middlewareMode: true },
  })
  try {
    const container = server.environments.client.pluginContainer
    for (const pool of ['', '?pool=1', '?pool=2', '?pool=auto', '?pool=unlimited']) {
      const direct = await container.resolveId(`./compute.rpc${pool}`, join(root, 'main.ts'))
      const linked = await container.resolveId(`./linked.rpc${pool}`, join(root, 'main.ts'))
      const alias = await container.resolveId(`@rpc${pool}`, join(root, 'main.ts'))
      assert.equal(linked?.id, direct?.id)
      assert.equal(alias?.id, direct?.id, `alias query ${pool}`)
    }
    assert.equal((await container.resolveId('./compute.rpc?pool=1', join(root, 'main.ts')))?.id, rpc)
    const raw = await server.transformRequest('/compute.rpc.ts?raw')
    assert.match(raw!.code, /export default/)
    assert.match(raw!.code, /export function add/)
    assert.doesNotMatch(raw!.code, /createRpcClient/)
    for (const query of ['url', 'worker', 'worker&inline', 'worker&url', 'sharedworker']) {
      const transformed = await server.transformRequest(`/compute.rpc.ts?${query}`)
      assert.match(transformed!.code, /export default/)
      assert.doesNotMatch(transformed!.code, /createRpcClient/)
    }
    await writeFile(join(root, 'main.ts'), [
      'import raw from "./compute.rpc.ts?raw";',
      'import url from "./compute.rpc.ts?url";',
      'import Worker from "./compute.rpc.ts?worker";',
      'import InlineWorker from "./compute.rpc.ts?worker&inline";',
      'import workerUrl from "./compute.rpc.ts?worker&url";',
      'import SharedWorker from "./compute.rpc.ts?sharedworker";',
      'globalThis.assets = { raw, url, Worker, InlineWorker, workerUrl, SharedWorker };',
    ].join('\n'))
    const built = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [workerRpc()],
      build: { write: false, minify: false, rollupOptions: { input: join(root, 'main.ts') } },
    })
    const outputs = (Array.isArray(built) ? built : [built]).flatMap(result => 'output' in result ? result.output : [])
    const code = outputs.filter(output => output.type === 'chunk').map(output => output.code).join('\n')
    assert.doesNotMatch(code, /createRpcClient/)
    assert.match(code, /globalThis.assets/)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a worker shares nested implementation state across local pool queries in development and production', { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-rpc-nested-pool-review-')))
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  try {
    await writeFile(join(root, 'nested.rpc.ts'), 'let count = 0; export function increment() { return ++count }')
    await writeFile(join(root, 'compute.rpc.ts'), [
      'import { increment as plain } from "./nested.rpc";',
      'import { increment as pooled } from "./nested.rpc?pool=2";',
      'export function check() { return [plain(), pooled()] }',
    ].join('\n'))
    await writeFile(join(root, 'main.ts'), 'import { check } from "./compute.rpc"; globalThis.result = check();')
    await writeFile(join(root, 'index.html'), '<script type="module" src="/main.ts"></script>')
    for (const mode of ['development', 'production']) {
      const config = {
        root,
        configFile: false as const,
        logLevel: 'silent' as const,
        plugins: [workerRpc()],
        server: { host: '127.0.0.1', port: 0 },
        preview: { host: '127.0.0.1', port: 0 },
      }
      if (mode === 'production') await build(config)
      const server = mode === 'development' ? await createServer(config) : await preview(config)
      if ('listen' in server) await server.listen()
      try {
        const page = await browser.newPage()
        try {
          await page.goto(server.resolvedUrls!.local[0]!)
          await page.waitForFunction(() => Boolean((globalThis as any).result))
          const result = await page.evaluate(async () => (globalThis as any).result)
          assert.deepEqual(result, [1, 2], `nested pool queries should share local state in ${mode}`)
        } finally {
          await page.close()
        }
      } finally {
        if ('listen' in server) await server.close()
        else await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
      }
    }
  } finally {
    await browser.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('production worker resolves exact-file aliases with a pool query', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-rpc-nested-alias-review-')))
  try {
    await writeFile(join(root, 'nested.rpc.ts'), 'export function add() { return 3 }')
    await writeFile(join(root, 'compute.rpc.ts'), 'import { add } from "@nested?pool=2"; export function check() { return add() }')
    await writeFile(join(root, 'main.ts'), 'import { check } from "./compute.rpc"; globalThis.result = check();')
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [workerRpc()],
      resolve: { alias: { '@nested': join(root, 'nested.rpc.ts') } },
      build: { write: false, rollupOptions: { input: join(root, 'main.ts') } },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production RPC workers preserve the caller-provided worker plugin factory', { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-rpc-custom-worker-plugin-review-')))
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  try {
    await writeFile(join(root, 'nested.rpc.ts'), 'export function marker() { return "before-worker-plugin" }')
    await writeFile(join(root, 'compute.rpc.ts'), [
      'import { marker } from "./nested.rpc?pool=auto";',
      'export function check() { return { marker: marker(), worker: typeof document === "undefined" } }',
    ].join('\n'))
    await writeFile(join(root, 'main.ts'), 'import { check } from "./compute.rpc?pool=2"; globalThis.result = check();')
    await writeFile(join(root, 'index.html'), '<script type="module" src="/main.ts"></script>')
    let factoryCalls = 0
    const config = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [workerRpc()],
      worker: {
        plugins: () => {
          factoryCalls += 1
          return [{
            name: 'caller-worker-marker',
            transform(code: string, id: string) {
              if (id.split('?')[0] === join(root, 'nested.rpc.ts')) {
                return code.replace('before-worker-plugin', 'after-worker-plugin')
              }
            },
          }]
        },
      },
      preview: { host: '127.0.0.1', port: 0 },
    }
    await build(config)
    assert.ok(factoryCalls > 0, 'the existing worker plugin factory must be called')
    const server = await preview(config)
    try {
      const page = await browser.newPage()
      try {
        await page.goto(server.resolvedUrls!.local[0]!)
        await page.waitForFunction(() => Boolean((globalThis as any).result))
        const result = await page.evaluate(async () => (globalThis as any).result)
        assert.deepEqual(result, { marker: 'after-worker-plugin', worker: true })
      } finally {
        await page.close()
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
    }
  } finally {
    await browser.close()
    await rm(root, { recursive: true, force: true })
  }
})
