import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Page } from 'playwright'
import { build, createServer, preview, type InlineConfig, type PreviewServer } from 'vite'
import workerRpc from '../src/index.js'

type StartedCall = { id: string; label: string }
type CompletedCall = StartedCall & { isWorker: boolean; nested: number; sharedNestedImplementation: boolean }

async function closeHttpServer(server: PreviewServer['httpServer']): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
}

async function runHeldBatch(page: Page, methods: string[]): Promise<StartedCall[]> {
  const channel = `project-defaults-${crypto.randomUUID()}`
  await page.evaluate(({ methods, channel }) => {
    const state = globalThis as any
    state.projectPoolStarts = []
    state.projectPoolPending = Promise.all(methods.map((method, index) => (
      state.projectPoolApi[method](`${method}:${index}`, channel)
    )))
  }, { methods, channel })
  // Every call must start before release, including those exceeding the pool
  // limit. This keeps the concurrency assertion independent of task timing.
  await page.waitForFunction(
    (count) => (globalThis as any).projectPoolStarts.length === count,
    methods.length,
    { timeout: 10_000 },
  )
  const starts: StartedCall[] = await page.evaluate(() => (globalThis as any).projectPoolStarts)
  const results: CompletedCall[] = await page.evaluate(async (channel) => {
    const release = new BroadcastChannel(channel)
    release.postMessage('release')
    release.close()
    return (globalThis as any).projectPoolPending
  }, channel)
  assert.equal(results.length, methods.length)
  for (const result of results) {
    assert.equal(result.isWorker, true)
    assert.equal(result.nested, 5, 'nested RPC imports must remain synchronous local functions')
    assert.equal(result.sharedNestedImplementation, true, 'nested pool queries must share the local implementation')
  }
  return starts
}

test('project pool defaults share resolved imports and allow query overrides in dev and production', { timeout: 90_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-project-defaults-')))
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  try {
    const fixtures = {
      'index.html': '<script type="module" src="/main.ts"></script>',
      'nested.rpc.ts': 'export function add(a: number, b: number) { return a + b }',
      'work.rpc.ts': `
        import { add as localAdd } from './nested.rpc'
        import { add as queriedAdd } from '@nested?pool=unlimited'
        const id = crypto.randomUUID()
        export async function hold(label: string, channel: string) {
          const release = new BroadcastChannel(channel)
          const released = new Promise<void>((resolve) => {
            release.addEventListener('message', () => resolve(), { once: true })
          })
          self.postMessage({ kind: 'project-pool-start', id, label })
          await released
          release.close()
          return {
            id,
            label,
            isWorker: typeof document === 'undefined',
            nested: queriedAdd(2, 3),
            sharedNestedImplementation: localAdd === queriedAdd,
          }
        }
      `,
      'caller-a.ts': "export { hold as fromA } from './work.rpc'",
      'caller-b.ts': "export { hold as fromB } from '@work?pool=2'",
      'main.ts': `
        import { hold as defaultHold } from './work.rpc'
        import { hold as twoHold } from './work.rpc.ts?pool=2'
        import { hold as aliasHold } from '@work'
        import { hold as oneHold } from './work.rpc?pool=1'
        import { hold as autoHold } from './work.rpc?pool=auto'
        import { fromA } from './caller-a'
        import { fromB } from './caller-b'
        globalThis.projectPoolApi = { defaultHold, twoHold, aliasHold, oneHold, autoHold, fromA, fromB }
        globalThis.projectPoolIdentity = {
          explicitMatchesDefault: defaultHold === twoHold,
          aliasMatchesDefault: defaultHold === aliasHold,
          callersMatchDefault: defaultHold === fromA && defaultHold === fromB,
          oneIsIndependent: oneHold !== defaultHold,
          autoIsIndependent: autoHold !== defaultHold && autoHold !== oneHold,
        }
      `,
    }
    await Promise.all(Object.entries(fixtures).map(([name, source]) => writeFile(join(root, name), source)))

    for (const mode of ['development', 'production'] as const) {
      await t.test(mode, { timeout: 40_000 }, async () => {
        const config: InlineConfig = {
          root,
          configFile: false,
          logLevel: 'error',
          plugins: [workerRpc({ pool: 2 })],
          resolve: { alias: { '@work': join(root, 'work.rpc.ts'), '@nested': join(root, 'nested.rpc.ts') } },
          server: { middlewareMode: true, hmr: false },
          preview: { host: '127.0.0.1', port: 0 },
          build: { target: 'es2022' },
        }
        let closeServer: (() => Promise<void>) | undefined
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        try {
          let url: string
          if (mode === 'development') {
            const vite = await createServer(config)
            const http = createHttpServer(vite.middlewares)
            closeServer = async () => { await Promise.all([vite.close(), closeHttpServer(http)]) }
            await new Promise<void>((resolve, reject) => {
              http.once('error', reject)
              http.listen(0, '127.0.0.1', () => {
                http.off('error', reject)
                resolve()
              })
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
            Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 5 })
            Object.assign(globalThis, { projectPoolWorkerCount: 0, projectPoolStarts: [] })
            const OriginalWorker = globalThis.Worker
            globalThis.Worker = class extends OriginalWorker {
              constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options)
                ;(globalThis as any).projectPoolWorkerCount += 1
                this.addEventListener('message', (event) => {
                  if (event.data?.kind === 'project-pool-start') (globalThis as any).projectPoolStarts.push(event.data)
                })
              }
            }
          })
          await page.goto(url)
          await page.waitForFunction(() => Boolean((globalThis as any).projectPoolApi), undefined, { timeout: 10_000 })
          assert.equal(await page.evaluate(() => (globalThis as any).projectPoolWorkerCount), 0, 'all configured variants stay lazy')
          assert.deepEqual(await page.evaluate(() => (globalThis as any).projectPoolIdentity), {
            explicitMatchesDefault: true,
            aliasMatchesDefault: true,
            callersMatchDefault: true,
            oneIsIndependent: true,
            autoIsIndependent: true,
          })
          const defaultMethods = ['defaultHold', 'twoHold', 'aliasHold', 'fromA', 'fromB', 'defaultHold']
          const starts = await runHeldBatch(page, [...defaultMethods, ...Array(3).fill('oneHold'), ...Array(6).fill('autoHold')])
          const idsFor = (methods: string[]) => [...new Set(starts
            .filter(({ label }) => methods.includes(label.split(':')[0]!))
            .map(({ id }) => id))].sort()
          const defaultIds = idsFor(defaultMethods)
          const oneIds = idsFor(['oneHold'])
          const autoIds = idsFor(['autoHold'])
          assert.equal(defaultIds.length, 2, 'unqueried, alias, and explicit pool=2 imports share the project-sized pool')
          assert.equal(oneIds.length, 1, 'pool=1 overrides the project default')
          assert.equal(autoIds.length, 4, 'explicit auto uses hardwareConcurrency minus one, not the project default')
          assert.equal(new Set([...defaultIds, ...oneIds, ...autoIds]).size, 7, 'different resolved modes own independent pools')
          assert.equal(await page.evaluate(() => (globalThis as any).projectPoolWorkerCount), 7)
          const reused = await runHeldBatch(page, defaultMethods)
          assert.deepEqual([...new Set(reused.map(({ id }) => id))].sort(), defaultIds)
          assert.equal(await page.evaluate(() => (globalThis as any).projectPoolWorkerCount), 7, 'the project pool reuses its workers')
          assert.deepEqual(errors, [], 'the page should have no uncaught errors')
        } finally {
          await page.close()
          await closeServer?.()
        }
      })
    }
  } finally {
    await browser.close()
    await rm(root, { recursive: true, force: true })
  }
})
