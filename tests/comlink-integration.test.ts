import assert from 'node:assert/strict'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build, createServer, preview, type InlineConfig, type PreviewServer } from 'vite'
import workerRpc from '../src/index.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = join(repository, 'tests/fixtures/comlink')

async function closeHttpServer(server: PreviewServer['httpServer']): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
}

test('Comlink proxies, transfers, custom handlers, and reserved export names work with a Worker pool in dev and production', { timeout: 100_000 }, async (t) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  try {
    for (const mode of ['development', 'production'] as const) {
      await t.test(mode, { timeout: 45_000 }, async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-comlink-')))
        let closeServer: (() => Promise<void>) | undefined
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        try {
          await cp(fixtureDirectory, root, { recursive: true })
          const config: InlineConfig = {
            root,
            configFile: false,
            logLevel: 'error',
            plugins: [workerRpc({ pool: 2, timeoutMs: 10_000 })],
            resolve: { alias: { 'vite-plugin-worker-rpc/client': join(repository, 'src/client.ts') } },
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
              server: { ...config.server, middlewareMode: true, hmr: { server: http } },
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
            Object.assign(globalThis, { comlinkWorkerCount: 0 })
            const OriginalWorker = globalThis.Worker
            globalThis.Worker = class extends OriginalWorker {
              constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options)
                ;(globalThis as any).comlinkWorkerCount += 1
              }
            }
          })
          await page.goto(url)
          await page.waitForFunction(() => Boolean((globalThis as any).comlinkApi), undefined, { timeout: 10_000 })
          assert.equal(await page.evaluate(() => (globalThis as any).comlinkWorkerCount), 0, 'worker creation remains lazy')

          const callbacks = await page.evaluate(() => (globalThis as any).comlinkApi.callbacks())
          assert.equal(callbacks.synchronous.value, 5)
          assert.equal(callbacks.asynchronous.value, 6)
          assert.equal(callbacks.synchronous.released, true)
          assert.equal(callbacks.asynchronous.released, true)
          assert.deepEqual(callbacks.errors, [
            { name: 'TypeError', message: 'synchronous callback error' },
            { name: 'TypeError', message: 'asynchronous callback error' },
          ])

          const shared = await page.evaluate(() => (globalThis as any).comlinkApi.sharedCallback())
          assert.deepEqual(shared.results.map((result: { value: number }) => result.value), [3, 6, 9, 12])
          assert.equal(new Set(shared.results.map((result: { workerId: string }) => result.workerId)).size, 2)
          assert.ok(shared.results.every((result: { released: boolean }) => result.released))
          assert.equal(shared.reused.value, 30)
          assert.equal(shared.reused.released, true)
          assert.equal(await page.evaluate(() => (globalThis as any).comlinkWorkerCount), 2)

          assert.deepEqual(await page.evaluate(() => (globalThis as any).comlinkApi.buffers()), {
            senderLength: 0, workerLength: 0, received: [8, 8, 9], copied: [20, 21], copy: [21, 21],
          })
          assert.deepEqual(await page.evaluate(() => (globalThis as any).comlinkApi.returnedFunction()), { value: 42, released: true })
          assert.deepEqual(await page.evaluate(() => (globalThis as any).comlinkApi.customHandler()), {
            helpersShareRegistry: true, isCustomValue: true, value: 12, doubled: 24,
          })
          assert.deepEqual(await page.evaluate(() => (globalThis as any).comlinkApi.specialExports()), [101, 202])
          assert.deepEqual(errors, [], 'proxy release and callback failures must not leak page errors')
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
