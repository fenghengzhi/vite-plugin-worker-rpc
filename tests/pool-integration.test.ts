import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { build, createServer, preview, type InlineConfig } from 'vite'
import workerRpc from '../src/index.js'

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/pool')
type Start = { id: string; label: string; activeAtStart: number }
type Result = Start & { isWorker: boolean; nested: number; sourceVersion: string; helperVersion: string }

async function openPage(browser: Browser, url: string, hardwareConcurrency?: number): Promise<Page> {
  const page = await browser.newPage()
  await page.addInitScript((hardware) => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, writable: true, value: hardware })
    Object.assign(globalThis, { poolWorkerCount: 0, poolStarts: [] })
    const OriginalWorker = globalThis.Worker
    globalThis.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        ;(globalThis as any).poolWorkerCount += 1
        this.addEventListener('message', (event) => {
          if (event.data?.kind === 'pool-test-start') (globalThis as any).poolStarts.push(event.data)
        })
      }
    }
  }, hardwareConcurrency)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((globalThis as any).poolApi), undefined, { timeout: 10_000 })
    return page
  } catch (error) {
    await page.close()
    throw error
  }
}

async function workerCount(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as any).poolWorkerCount)
}

async function heldBatch(page: Page, methods: string[]): Promise<{ starts: Start[]; results: Result[] }> {
  const channel = `pool-test-${crypto.randomUUID()}`
  await page.evaluate(({ methods, channel }) => {
    const state = globalThis as any
    state.poolStarts = []
    state.poolPending = Promise.all(methods.map((method: string, i: number) => state.poolApi[method](`${method}:${i}`, channel)))
  }, { methods, channel })
  // Nothing is released until every call starts. A main-thread queue would
  // deadlock here as soon as the batch contains more calls than the pool size.
  await page.waitForFunction((count) => (globalThis as any).poolStarts.length === count, methods.length, { timeout: 8_000 })
  const starts: Start[] = await page.evaluate(() => (globalThis as any).poolStarts)
  const results: Result[] = await page.evaluate(async (name) => {
    const release = new BroadcastChannel(name)
    release.postMessage('release')
    release.close()
    return (globalThis as any).poolPending
  }, channel)
  for (const result of results) {
    assert.equal(result.isWorker, true)
    assert.equal(result.nested, 5, 'queried nested RPC imports must execute locally within the worker')
  }
  return { starts, results }
}

const workerIds = (starts: Start[]) => [...new Set(starts.map((item) => item.id))].sort()

async function checkSharingAndLimits(page: Page): Promise<void> {
  assert.equal(await workerCount(page), 0, 'importing all pool variants must remain lazy')
  const one = await heldBatch(page, ['defaultHold', 'oneHold', 'aliasOneHold'])
  assert.equal(workerIds(one.starts).length, 1, 'default, pool=1, and alias imports must share one worker')
  assert.deepEqual(one.starts.map((item) => item.activeAtStart).sort(), [1, 2, 3])
  assert.equal(await workerCount(page), 1)

  const two = await heldBatch(page, ['twoHold', 'holdA', 'holdB', 'twoHold', 'holdA', 'holdB'])
  assert.equal(workerIds(two.starts).length, 2, 'direct, multi-file, explicit-extension, and alias imports share pool=2')
  assert.ok(!workerIds(two.starts).includes(workerIds(one.starts)[0]!))
  assert.equal(await workerCount(page), 3, 'different pool configurations are independent')
  for (const id of workerIds(two.starts)) {
    assert.deepEqual(two.starts.filter((item) => item.id === id).map((item) => item.activeAtStart).sort(), [1, 2, 3],
      'at capacity, calls should go to a worker with the fewest in-flight calls')
  }
  const reuse = await heldBatch(page, Array(8).fill('twoHold'))
  assert.deepEqual(workerIds(reuse.starts), workerIds(two.starts))
  assert.equal(await workerCount(page), 3)
  const idle = await heldBatch(page, ['twoHold'])
  assert.ok(workerIds(two.starts).includes(idle.starts[0]!.id))
  assert.equal(await workerCount(page), 3, 'idle workers should be reused')

  const unlimited = await heldBatch(page, Array(7).fill('unlimitedHold'))
  assert.equal(workerIds(unlimited.starts).length, 7)
  assert.equal(await workerCount(page), 10)
  const unlimitedReuse = await heldBatch(page, Array(7).fill('unlimitedHold'))
  assert.deepEqual(workerIds(unlimitedReuse.starts), workerIds(unlimited.starts))
  assert.equal(await workerCount(page), 10, 'unlimited pools should reuse workers from the previous peak')
  await heldBatch(page, ['unlimitedHold'])
  assert.equal(await workerCount(page), 10)
}

async function checkAuto(browser: Browser, url: string): Promise<void> {
  for (const { initial, firstCall, cap } of [
    { initial: 2, firstCall: 4, cap: 3 },
    { initial: 3, firstCall: 12, cap: 11 },
    { initial: undefined, firstCall: undefined, cap: 4 },
    { initial: 0, firstCall: 0, cap: 4 },
    { initial: 1, firstCall: 1, cap: 1 },
  ]) {
    const page = await openPage(browser, url, initial)
    try {
      assert.equal(await workerCount(page), 0)
      await page.evaluate((value) => Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value }), firstCall)
      const first = await heldBatch(page, Array(cap + 2).fill('autoHold'))
      assert.equal(workerIds(first.starts).length, cap, `auto cap for hardwareConcurrency=${String(firstCall)}`)
      assert.equal(await workerCount(page), cap)
      await page.evaluate(() => Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 32 }))
      const reused = await heldBatch(page, Array(cap + 3).fill('autoHold'))
      assert.deepEqual(workerIds(reused.starts), workerIds(first.starts), 'the auto cap must freeze at the first call')
      assert.equal(await workerCount(page), cap)
    } finally {
      await page.close()
    }
  }
}

async function checkHmr(page: Page, fixtureRoot: string): Promise<void> {
  for (const [file, before, after, property] of [
    ['work.rpc.ts', 'source:original', 'source:updated', 'sourceVersion'],
    ['helper.ts', 'helper:original', 'helper:updated', 'helperVersion'],
  ] as const) {
    const bootId = await page.evaluate(() => (globalThis as any).poolBootId)
    const path = join(fixtureRoot, file)
    await writeFile(path, (await readFile(path, 'utf8')).replace(before, after))
    await page.waitForFunction((previous) => Boolean((globalThis as any).poolBootId) && (globalThis as any).poolBootId !== previous, bootId)
    const result = await page.evaluate(async () => (globalThis as any).poolApi.twoRun('after HMR'))
    assert.equal(result[property], after, `${file} must refresh queried RPC workers`)
  }
}

test('worker pools share imports and honor finite, unlimited, and auto limits in dev and production', { timeout: 180_000 }, async (t) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  })
  try {
    for (const mode of ['development', 'production'] as const) {
      await t.test(mode, { timeout: 85_000 }, async () => {
        const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-pool-')))
        let closeServer: (() => Promise<void>) | undefined
        let page: Page | undefined
        try {
          await cp(fixtureDirectory, fixtureRoot, { recursive: true })
          const config: InlineConfig = {
            root: fixtureRoot,
            configFile: false,
            base: '/pool-test/',
            logLevel: 'error',
            plugins: [workerRpc({ timeoutMs: 15_000 })],
            resolve: { alias: { '@pool-worker': join(fixtureRoot, 'work.rpc.ts') } },
            server: { host: '127.0.0.1', port: 0 },
            preview: { host: '127.0.0.1', port: 0 },
            build: { target: 'es2022' },
          }
          let url: string
          if (mode === 'development') {
            const server = await createServer(config)
            closeServer = () => server.close()
            await server.listen()
            url = server.resolvedUrls!.local[0]!
          } else {
            await build(config)
            const server = await preview(config)
            closeServer = () => new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
            url = server.resolvedUrls!.local[0]!
          }
          assert.equal(new URL(url).pathname, '/pool-test/')
          page = await openPage(browser, url, 4)
          await checkSharingAndLimits(page)
          await checkAuto(browser, url)
          if (mode === 'development') await checkHmr(page, fixtureRoot)
        } finally {
          await page?.close()
          await closeServer?.()
          await rm(fixtureRoot, { recursive: true, force: true })
        }
      })
    }
  } finally {
    await browser.close()
  }
})

test('invalid pool query values fail during Vite transformation and production build', { timeout: 30_000 }, async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-invalid-pool-')))
  let closeServer: (() => Promise<void>) | undefined
  try {
    await writeFile(join(fixtureRoot, 'compute.rpc.ts'), 'export function add(a: number, b: number) { return a + b }')
    const server = await createServer({ root: fixtureRoot, configFile: false, logLevel: 'silent', plugins: [workerRpc()], server: { middlewareMode: true } })
    closeServer = () => server.close()
    for (const pool of ['', '0', '-1', '1.5', 'many', 'Infinity']) {
      await assert.rejects(server.transformRequest(`/compute.rpc.ts?pool=${encodeURIComponent(pool)}`), /pool/i, `pool=${pool} should be rejected`)
    }
    await writeFile(join(fixtureRoot, 'invalid.ts'), 'import { add } from "./compute.rpc?pool=0"; globalThis.result = add(1, 2)')
    await assert.rejects(build({
      root: fixtureRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [workerRpc()],
      build: { write: false, rollupOptions: { input: join(fixtureRoot, 'invalid.ts') } },
    }), /pool/i)
  } finally {
    await closeServer?.()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('queried RPC modules remain safe to import during SSR', { timeout: 15_000 }, async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-pool-ssr-')))
  let closeServer: (() => Promise<void>) | undefined
  try {
    await writeFile(join(fixtureRoot, 'compute.rpc.ts'), 'throw new Error("RPC source must not run during SSR"); export function add(a: number, b: number) { return a + b }')
    const server = await createServer({ root: fixtureRoot, configFile: false, logLevel: 'silent', plugins: [workerRpc()], server: { middlewareMode: true } })
    closeServer = () => server.close()
    const defaultApi = await server.ssrLoadModule('/compute.rpc.ts')
    const oneApi = await server.ssrLoadModule('/compute.rpc.ts?pool=1')
    assert.equal(defaultApi.add, oneApi.add, 'default and explicit pool=1 resolve to one module')
    for (const pool of ['1', '2', 'auto', 'unlimited']) {
      const api = await server.ssrLoadModule(`/compute.rpc.ts?pool=${pool}`)
      assert.equal(typeof api.add, 'function')
      await assert.rejects(api.add(1, 2), /browser.*Web Worker.*SSR/)
    }
  } finally {
    await closeServer?.()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
