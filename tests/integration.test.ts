import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { build, createServer, preview, type InlineConfig } from 'vite'
import workerRpc from '../src/index.js'

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/app')

async function exerciseRpc(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as any).rpcTest))
  assert.equal(await page.evaluate(() => (globalThis as any).rpcWorkerCount), 0,
    'workers should be created lazily on first call')

  const runtime = await page.evaluate(async () => (globalThis as any).rpcTest.inspectRuntime())
  assert.deepEqual(runtime, {
    noDocument: true,
    isWorker: true,
    nested: 7,
    helperVersion: 'helper:original',
  })
  assert.equal(await page.evaluate(() => (globalThis as any).rpcWorkerCount), 1)

  const results = await page.evaluate(async () => {
    const rpc = (globalThis as any).rpcTest
    const call = rpc.add(5, 8)
    const isPromise = call instanceof Promise
    return {
      isPromise,
      sum: await call,
      defaultSum: await rpc.add(),
      alias: await rpc.renamed(4),
      concurrent: await Promise.all([
        rpc.delayed('slow', 70),
        rpc.delayed('fast', 5),
        rpc.delayed('middle', 25),
      ]),
      counter: [await rpc.counter(), await rpc.counter()],
      sourceVersion: await rpc.sourceVersion(),
    }
  })
  assert.deepEqual(results, {
    isPromise: true,
    sum: 13,
    defaultSum: 3,
    alias: 12,
    concurrent: ['slow', 'fast', 'middle'],
    counter: [1, 2],
    sourceVersion: 'source:original',
  })
  assert.equal(await page.evaluate(() => (globalThis as any).rpcWorkerCount), 1,
    'exports from the same module should reuse one worker')

  const clone = await page.evaluate(async () => {
    const input = {
      nested: { count: 4 },
      values: new Map([['main', 1]]),
      created: new Date('2026-01-01T00:00:00.000Z'),
      bytes: new Uint8Array([1, 2, 3]),
    }
    const output = await (globalThis as any).rpcTest.echo(input)
    return {
      originalCount: input.nested.count,
      originalMap: [...input.values],
      originalBytes: [...input.bytes],
      returnedCount: output.nested.count,
      returnedMap: [...output.values],
      returnedDate: output.created instanceof Date && output.created.toISOString(),
      returnedBytes: [...output.bytes],
      returnedTypedArray: output.bytes instanceof Uint8Array,
    }
  })
  assert.deepEqual(clone, {
    originalCount: 4,
    originalMap: [['main', 1]],
    originalBytes: [1, 2, 3],
    returnedCount: 5,
    returnedMap: [['main', 1], ['worker', 2]],
    returnedDate: '2026-01-01T00:00:00.000Z',
    returnedBytes: [42, 2, 3],
    returnedTypedArray: true,
  })

  const failure = await page.evaluate(async () => {
    try {
      await (globalThis as any).rpcTest.fail()
      return null
    } catch (error) {
      const remote = error as Error
      return { name: remote.name, message: remote.message }
    }
  })
  assert.deepEqual(failure, { name: 'TypeError', message: 'failure from the worker' })
  assert.equal(await page.evaluate(async () => (globalThis as any).rpcTest.add(2, 3)), 5,
    'a remote exception should not break later calls')
  assert.equal(await page.evaluate(async () => (globalThis as any).rpcTest.subtract(8, 3)), 5)
  assert.equal(await page.evaluate(() => (globalThis as any).rpcWorkerCount), 2,
    'different RPC modules should have separate workers')
}

async function checkHmr(page: Page, fixtureRoot: string): Promise<void> {
  for (const [file, before, after, exportName, property] of [
    ['compute.rpc.ts', 'source:original', 'source:updated', 'sourceVersion', undefined],
    ['helper.ts', 'helper:original', 'helper:updated', 'inspectRuntime', 'helperVersion'],
  ] as const) {
    const previousBootId = await page.evaluate(() => (globalThis as any).rpcBootId)
    const path = join(fixtureRoot, file)
    const source = await readFile(path, 'utf8')
    assert.ok(source.includes(before))
    await writeFile(path, source.replace(before, after))
    await page.waitForFunction(
      (previous) => Boolean((globalThis as any).rpcBootId) && (globalThis as any).rpcBootId !== previous,
      previousBootId,
      { timeout: 15_000 },
    )
    const result = await page.evaluate(async ({ name, key }) => {
      const value = await (globalThis as any).rpcTest[name]()
      return key ? value[key] : value
    }, { name: exportName, key: property })
    assert.equal(result, after, `${file} edits should reload the page and update worker code`)
  }
}

test('RPC modules run in real browser workers in Vite dev and production', { timeout: 120_000 }, async (t) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  })
  try {
    for (const mode of ['development', 'production'] as const) {
      await t.test(mode, { timeout: 55_000 }, async () => {
        const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-')))
        let closeServer: (() => Promise<void>) | undefined
        const page = await browser.newPage()
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        try {
          await cp(fixtureDirectory, fixtureRoot, { recursive: true })
          const config: InlineConfig = {
            root: fixtureRoot,
            configFile: false,
            base: '/demo/',
            logLevel: 'error',
            plugins: [workerRpc({ timeoutMs: 5_000 })],
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
            closeServer = () => new Promise<void>((resolve, reject) => {
              server.httpServer.close((error) => error ? reject(error) : resolve())
            })
            url = server.resolvedUrls!.local[0]!
          }
          assert.ok(new URL(url).pathname.startsWith('/demo/'))
          await page.addInitScript(() => {
            const OriginalWorker = globalThis.Worker
            Object.assign(globalThis, { rpcWorkerCount: 0 })
            globalThis.Worker = class extends OriginalWorker {
              constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options)
                ;(globalThis as any).rpcWorkerCount += 1
              }
            }
          })
          await page.goto(url)
          await exerciseRpc(page)
          if (mode === 'development') await checkHmr(page, fixtureRoot)
          assert.deepEqual(pageErrors, [], 'the main page should have no uncaught errors')
        } finally {
          await page.close()
          await closeServer?.()
          await rm(fixtureRoot, { recursive: true, force: true })
        }
      })
    }
  } finally {
    await browser.close()
  }
})

test('the built plugin supports custom include and exclude patterns in a real browser', { timeout: 30_000 }, async () => {
  const { default: builtWorkerRpc } = await import(new URL('../dist/index.js', import.meta.url).href)
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-options-')))
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  })
  let closeServer: (() => Promise<void>) | undefined
  try {
    await cp(join(fixtureDirectory, '../custom'), fixtureRoot, { recursive: true })
    const server = await createServer({
      root: fixtureRoot,
      configFile: false,
      base: '/custom/',
      logLevel: 'error',
      plugins: [builtWorkerRpc({
        include: ['*.worker-rpc.ts'],
        exclude: ['excluded.worker-rpc.ts'],
      })],
      server: { host: '127.0.0.1', port: 0 },
    })
    closeServer = () => server.close()
    await server.listen()
    const page = await browser.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(server.resolvedUrls!.local[0]!)
    await page.waitForFunction(() => Boolean((globalThis as any).customRpcTest))
    const result = await page.evaluate(async () => {
      const api = (globalThis as any).customRpcTest
      return { remote: await api.inspect(), local: api.localValue }
    })
    assert.deepEqual(result, {
      remote: { noDocument: true, isWorker: true },
      local: 'main thread',
    })
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    await closeServer?.()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('SSR can import RPC proxies without executing their source, but calling reports unsupported Workers', { timeout: 15_000 }, async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'vite-worker-rpc-ssr-')))
  let closeServer: (() => Promise<void>) | undefined
  try {
    await cp(join(fixtureDirectory, '../ssr'), fixtureRoot, { recursive: true })
    const server = await createServer({
      root: fixtureRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [workerRpc()],
      server: { middlewareMode: true },
    })
    closeServer = () => server.close()
    const api = await server.ssrLoadModule('/ssr.rpc.ts')
    assert.equal(typeof api.add, 'function')
    await assert.rejects(api.add(1, 2), /browser.*Web Worker.*SSR/)
  } finally {
    await closeServer?.()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
