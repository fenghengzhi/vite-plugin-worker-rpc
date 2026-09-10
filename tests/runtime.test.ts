import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { createRpcClient, exposeRpc, type RpcClientOptions, type RpcEndpoint, type RpcWorker } from '../src/runtime.js'

type Listener = (event: never) => void

class FakePort {
  peer?: FakePort
  listeners = new Map<string, Set<Listener>>()
  terminated = 0
  closed = false

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type)
    if (!listeners) this.listeners.set(type, listeners = new Set())
    listeners.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const cloned = structuredClone(message, { transfer })
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', { data: cloned })
    })
  }

  start(): void {}

  terminate(): void {
    this.terminated++
    this.closed = true
    if (this.peer) this.peer.closed = true
  }
}

test('expose initialization failure removes its transport listeners', () => {
  const endpoint = new class extends FakePort {
    start(): void { throw new Error('endpoint cannot start') }
  }()
  assert.throws(() => exposeRpc({}, endpoint as unknown as RpcEndpoint), /endpoint cannot start/)
  for (const listeners of endpoint.listeners.values()) assert.equal(listeners.size, 0)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function pair(api: object, options: { timeoutMs?: number } = {}) {
  const worker = new FakePort()
  const server = new FakePort()
  worker.peer = server
  server.peer = worker
  let created = 0
  const cleanup = exposeRpc(api, server as unknown as RpcEndpoint)
  const client = createRpcClient(() => {
    created++
    return worker as unknown as RpcWorker
  }, { ...options, pool: 1 })
  return { worker, server, client, cleanup, get created() { return created } }
}

interface Invocation {
  args: unknown[]
  resolve(value: unknown): void
  reject(reason: unknown): void
}

class FakeWorker extends FakePort {
  calls: Invocation[] = []
}

function poolContext(options?: RpcClientOptions) {
  const workers: FakeWorker[] = []
  let totalStarted = 0
  const startedWaiters = new Set<{ count: number; resolve(): void }>()
  const client = createRpcClient(() => {
    const worker = new FakeWorker()
    const server = new FakePort()
    worker.peer = server
    server.peer = worker
    workers.push(worker)
    exposeRpc({
      hold(...args: unknown[]) {
        const gate = deferred<unknown>()
        worker.calls.push({ args, resolve: gate.resolve, reject: gate.reject })
        totalStarted++
        for (const waiter of startedWaiters) {
          if (totalStarted >= waiter.count) {
            startedWaiters.delete(waiter)
            waiter.resolve()
          }
        }
        return gate.promise
      },
      echo: (value: unknown) => value,
    }, server as unknown as RpcEndpoint)
    return worker as unknown as RpcWorker
  }, options)

  function started(count: number): Promise<void> {
    if (totalStarted >= count) return Promise.resolve()
    return new Promise(resolve => startedWaiters.add({ count, resolve }))
  }

  function resolveAll() {
    for (const worker of workers) {
      for (const call of worker.calls) call.resolve('done')
    }
  }

  return { client, workers, started, resolveAll }
}

function replaceNavigator(value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
}

function assertNoListeners(worker: FakePort): void {
  for (const listeners of worker.listeners.values()) assert.equal(listeners.size, 0)
}

test('lazily creates one worker and calls sync and async exports', async () => {
  const context = pair({
    add: (a: number, b: number) => a + b,
    async double(value: number) { return value * 2 },
  })
  assert.equal(context.created, 0)
  assert.equal(await context.client.call('add', [2, 3]), 5)
  assert.equal(await context.client.call('double', [4]), 8)
  assert.equal(context.created, 1)
  context.client.dispose()
  assert.equal(context.worker.terminated, 1)
})

test('correlates concurrent calls that finish out of order', async () => {
  const context = poolContext({ pool: 1 })
  const first = context.client.call('hold', ['first'])
  const second = context.client.call('hold', ['second'])
  await context.started(2)
  assert.deepEqual(context.workers[0]!.calls.map(call => call.args), [['first'], ['second']])
  context.workers[0]!.calls[1]!.resolve('two')
  assert.equal(await second, 'two')
  context.workers[0]!.calls[0]!.resolve('one')
  assert.equal(await first, 'one')
  context.client.dispose()
})

test('preserves remote Error names, messages, and stacks', async () => {
  const context = pair({
    fail() { throw new RangeError('outside range') },
    async reject() { throw new TypeError('bad input') },
  })
  await assert.rejects(context.client.call('fail', []), error => {
    assert.equal((error as Error).name, 'RangeError')
    assert.equal((error as Error).message, 'outside range')
    assert.match((error as Error).stack!, /runtime\.test\.ts/)
    return true
  })
  await assert.rejects(context.client.call('reject', []), { name: 'TypeError', message: 'bad input' })
  context.client.dispose()
})

test('non-Error thrown values reject their call without breaking subsequent calls', async () => {
  const context = pair({
    throwString() { throw 'plain failure' },
    echo: (value: unknown) => value,
  })
  await assert.rejects(context.client.call('throwString', []), reason => {
    assert.ok(reason === 'plain failure' || reason instanceof Error && reason.message.includes('plain failure'))
    return true
  })
  assert.equal(await context.client.call('echo', [42]), 42)
  context.client.dispose()
})

test('rejects missing, inherited, and non-function exports', async () => {
  const context = pair({ constant: 42 })
  for (const method of ['missing', 'constant', 'toString', 'constructor']) {
    await assert.rejects(context.client.call(method, []), { name: 'TypeError' })
  }
  context.client.dispose()
})

test('clone failures reject one call while subsequent calls still work', async () => {
  const context = pair({ echo: (value: unknown) => value, badResult: () => () => 1 })
  await assert.rejects(context.client.call('echo', [() => 1]), { name: 'DataCloneError' })
  await assert.rejects(context.client.call('badResult', []), { name: 'TypeError', message: 'Unserializable return value' })
  const original = { date: new Date(0), map: new Map([['answer', 42]]) }
  const result = await context.client.call('echo', [original])
  assert.deepEqual(result, original)
  assert.notEqual(result, original)
  assert.equal(context.created, 1)
  context.client.dispose()
})

test('dispose rejects all pending and future calls and removes listeners', async () => {
  const context = poolContext({ pool: 1 })
  const first = assert.rejects(context.client.call('hold', []), /disposed/)
  const second = assert.rejects(context.client.call('hold', []), /disposed/)
  await context.started(2)
  context.client.dispose()
  await Promise.all([first, second])
  await assert.rejects(context.client.call('hold', []), /disposed/)
  context.client.dispose()
  assert.equal(context.workers[0]!.terminated, 1)
  assertNoListeners(context.workers[0]!)
})

test('disposing an unused client never creates a worker', async () => {
  const context = pair({})
  context.client.dispose()
  await assert.rejects(context.client.call('anything', []), /disposed/)
  assert.equal(context.created, 0)
})

for (const event of ['error', 'messageerror']) {
  test(`worker ${event} rejects pending and future calls and terminates once`, async () => {
    const context = poolContext({ pool: 1 })
    const expected = event === 'error' ? /worker crashed/ : /deserialize/
    const first = assert.rejects(context.client.call('hold', []), expected)
    const second = assert.rejects(context.client.call('hold', []), expected)
    await context.started(2)
    context.workers[0]!.emit(event, { message: 'worker crashed' })
    await Promise.all([first, second])
    await assert.rejects(context.client.call('hold', []), expected)
    context.client.dispose()
    assert.equal(context.workers[0]!.terminated, 1)
    assert.equal(context.workers.length, 1)
    assertNoListeners(context.workers[0]!)
  })
}

test('a worker construction failure is an asynchronous terminal rejection', async () => {
  let attempts = 0
  const client = createRpcClient(() => { attempts++; throw new Error('worker unavailable') })
  await assert.rejects(client.call('run', []), /worker unavailable/)
  await assert.rejects(client.call('run', []), /worker unavailable/)
  assert.equal(attempts, 1)
  client.dispose()
})

test('timeout rejects only the timed out call and accepts subsequent calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const context = poolContext({ pool: 1, timeoutMs: 20 })
  const timeout = assert.rejects(context.client.call('hold', []), { name: 'TimeoutError' })
  await context.started(1)
  t.mock.timers.tick(20)
  await timeout
  context.workers[0]!.calls[0]!.resolve(42)
  assert.equal(await context.client.call('echo', [5]), 5)
  assert.equal(context.workers.length, 1)
  context.client.dispose()
})

test('the default timeout and explicit zero both allow long-running calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const options of [{ pool: 1 }, { pool: 1, timeoutMs: 0 }]) {
    const context = poolContext(options)
    const result = context.client.call('hold', [])
    let settled = false
    void result.then(() => { settled = true }, () => { settled = true })
    await context.started(1)
    t.mock.timers.tick(60_001)
    await nextTurn()
    assert.equal(settled, false)
    context.workers[0]!.calls[0]!.resolve('finished')
    assert.equal(await result, 'finished')
    context.client.dispose()
  }
})

test('validates timeout options', () => {
  for (const timeoutMs of [-1, NaN, Infinity]) {
    assert.throws(() => createRpcClient(() => new FakePort() as unknown as RpcWorker, { timeoutMs }), RangeError)
  }
})

test('server cleanup removes its listener and suppresses an in-flight response', async () => {
  const started = deferred<void>()
  const finish = deferred<number>()
  const context = pair({ hold: () => { started.resolve(); return finish.promise } })
  const result = context.client.call('hold', [])
  const rejection = assert.rejects(result, /disposed/)
  let settled = false
  void result.then(() => { settled = true }, () => { settled = true })
  await started.promise
  context.cleanup()
  assertNoListeners(context.server)
  finish.resolve(42)
  // FakePort delivers via microtasks; crossing a turn drains any response without
  // assuming how many promises the RPC library uses to process it.
  await nextTurn()
  assert.equal(settled, false)
  context.client.dispose()
  await rejection
})

for (const pool of [1, 2, 3]) {
  test(`pool=${pool} dispatches all calls immediately without exceeding the ceiling`, async () => {
    const context = poolContext({ pool })
    assert.equal(context.workers.length, 0)
    const calls = Array.from({ length: 11 }, (_, index) => context.client.call('hold', [index]))
    await context.started(11)
    assert.equal(context.workers.length, pool)
    const counts = context.workers.map(worker => worker.calls.length)
    assert.equal(counts.reduce((sum, value) => sum + value, 0), 11, 'calls must not enter a main-thread queue')
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1)
    assert.deepEqual(context.workers.flatMap(worker => worker.calls.map(call => call.args[0])).sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 11 }, (_, index) => index))
    context.resolveAll()
    await Promise.all(calls)
    context.client.dispose()
  })
}

test('finite pools reuse idle workers before creating another', async () => {
  const context = poolContext({ pool: 3 })
  const first = context.client.call('hold', ['first'])
  await context.started(1)
  context.workers[0]!.calls[0]!.resolve('done')
  await first
  const second = context.client.call('hold', ['second'])
  await context.started(2)
  assert.equal(context.workers.length, 1)
  const third = context.client.call('hold', ['third'])
  await context.started(3)
  assert.equal(context.workers.length, 2)
  context.workers[0]!.calls[1]!.resolve('done')
  await second
  const fourth = context.client.call('hold', ['fourth'])
  await context.started(4)
  assert.equal(context.workers.length, 2, 'an idle worker should prevent unnecessary growth')
  assert.deepEqual(context.workers[0]!.calls.map(call => call.args), [['first'], ['second'], ['fourth']])
  context.resolveAll()
  await Promise.all([third, fourth])
  context.client.dispose()
})

test('a full pool dispatches to the worker with the fewest actual outstanding calls', async () => {
  const context = poolContext({ pool: 3 })
  const calls = Array.from({ length: 7 }, (_, index) => context.client.call('hold', [index]))
  await context.started(7)
  assert.deepEqual(context.workers.map(worker => worker.calls.length), [3, 2, 2])
  context.workers[1]!.calls[0]!.resolve('done')
  await calls[1]
  calls.push(context.client.call('hold', ['least-loaded']))
  await context.started(8)
  assert.deepEqual(context.workers.map(worker => worker.calls.length), [3, 3, 2])
  assert.deepEqual(context.workers[1]!.calls[2]!.args, ['least-loaded'])
  context.resolveAll()
  await Promise.all(calls)
  context.client.dispose()
})

test('remote rejections release the finished call without releasing other work', async () => {
  const context = poolContext({ pool: 'unlimited' })
  const first = context.client.call('hold', ['first'])
  const rejection = assert.rejects(first, { name: 'RangeError', message: 'failed computation' })
  const second = context.client.call('hold', ['second'])
  await context.started(2)
  context.workers[0]!.calls[0]!.reject(new RangeError('failed computation'))
  await rejection
  const third = context.client.call('hold', ['third'])
  await context.started(3)
  assert.equal(context.workers.length, 2)
  assert.deepEqual(context.workers.map(worker => worker.calls.map(call => call.args)), [[['first'], ['third']], [['second']]])
  context.resolveAll()
  await Promise.all([second, third])
  context.client.dispose()
})

test('unlimited grows to peak concurrency and reuses retained workers', async () => {
  const context = poolContext({ pool: 'unlimited' })
  const firstBurst = Array.from({ length: 32 }, () => context.client.call('hold', []))
  await context.started(32)
  assert.equal(context.workers.length, 32)
  context.resolveAll()
  await Promise.all(firstBurst)
  assert.ok(context.workers.every(worker => worker.terminated === 0))
  const secondBurst = Array.from({ length: 9 }, () => context.client.call('hold', []))
  await context.started(41)
  assert.equal(context.workers.length, 32)
  context.resolveAll()
  await Promise.all(secondBurst)
  context.client.dispose()
  assert.ok(context.workers.every(worker => worker.terminated === 1))
})

test('timeouts retain actual worker occupancy until a late result arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const context = poolContext({ pool: 'unlimited', timeoutMs: 20 })
  const timeout = assert.rejects(context.client.call('hold', ['timed out']), { name: 'TimeoutError' })
  await context.started(1)
  t.mock.timers.tick(20)
  await timeout
  const second = context.client.call('hold', ['second'])
  await context.started(2)
  assert.equal(context.workers.length, 2, 'a timed-out computation is still busy')
  context.workers[0]!.calls[0]!.resolve('late result')
  await nextTurn()
  const third = context.client.call('hold', ['third'])
  await context.started(3)
  assert.equal(context.workers.length, 2, 'the late result makes that worker reusable')
  assert.deepEqual(context.workers[0]!.calls[1]!.args, ['third'])
  context.resolveAll()
  await Promise.all([second, third])
  context.client.dispose()
})

test('argument clone errors release pool occupancy immediately', async () => {
  const context = poolContext({ pool: 'unlimited' })
  await assert.rejects(context.client.call('echo', [() => 1]), { name: 'DataCloneError' })
  assert.equal(await context.client.call('echo', [42]), 42)
  assert.equal(context.workers.length, 1)
  context.client.dispose()
})

test('dispose rejects every pooled call and terminates every worker once', async () => {
  const context = poolContext({ pool: 3 })
  const rejections = Array.from({ length: 8 }, () =>
    assert.rejects(context.client.call('hold', []), /disposed/),
  )
  await context.started(8)
  context.client.dispose()
  await Promise.all(rejections)
  context.client.dispose()
  await assert.rejects(context.client.call('hold', []), /disposed/)
  assert.equal(context.workers.length, 3)
  for (const worker of context.workers) {
    assert.equal(worker.terminated, 1)
    assertNoListeners(worker)
  }
})

for (const event of ['error', 'messageerror']) {
  test(`one pooled worker ${event} rejects all calls and terminates the entire pool`, async () => {
    const context = poolContext({ pool: 3 })
    const expected = event === 'error' ? /pool worker crashed/ : /deserialize/
    const rejections = Array.from({ length: 6 }, () =>
      assert.rejects(context.client.call('hold', []), expected),
    )
    await context.started(6)
    context.workers[1]!.emit(event, { message: 'pool worker crashed' })
    await Promise.all(rejections)
    await assert.rejects(context.client.call('hold', []), expected)
    for (const worker of context.workers) {
      assert.equal(worker.terminated, 1)
      assertNoListeners(worker)
    }
    context.client.dispose()
  })
}

test('a pool expansion failure also terminates previously created workers', async () => {
  const worker = new FakePort()
  const server = new FakePort()
  worker.peer = server
  server.peer = worker
  const started = deferred<void>()
  exposeRpc({ hold: () => { started.resolve(); return new Promise(() => {}) } }, server as unknown as RpcEndpoint)
  let attempts = 0
  const client = createRpcClient(() => {
    if (++attempts > 1) throw new Error('cannot create another worker')
    return worker as unknown as RpcWorker
  }, { pool: 2 })
  const first = assert.rejects(client.call('hold', []), /cannot create another worker/)
  await started.promise
  await assert.rejects(client.call('hold', []), /cannot create another worker/)
  await first
  assert.equal(worker.terminated, 1)
  assertNoListeners(worker)
  client.dispose()
})

test('validates pool options without creating workers', () => {
  const factory = () => { throw new Error('factory should not run') }
  for (const pool of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', 'invalid', null, true, {}]) {
    assert.throws(() => createRpcClient(factory, { pool } as RpcClientOptions), RangeError)
  }
  for (const pool of [1, 2, Number.MAX_SAFE_INTEGER, 'auto', 'unlimited'] as const) {
    createRpcClient(factory, { pool }).dispose()
  }
})

for (const [concurrency, expected] of [
  [1, 1], [2, 1], [4, 3], [16, 15],
  [0, 4], [-1, 4], [1.5, 4], [NaN, 4], [Infinity, 4],
  [Number.MAX_SAFE_INTEGER + 1, 4], [undefined, 4], ['8', 4],
] as const) {
  test(`auto uses ${String(concurrency)} hardware threads to select ${expected} workers`, async (t) => {
    t.after(replaceNavigator({ hardwareConcurrency: concurrency }))
    const context = poolContext({ pool: 'auto' })
    const calls = Array.from({ length: expected + 2 }, () => context.client.call('hold', []))
    await context.started(expected + 2)
    assert.equal(context.workers.length, expected)
    context.resolveAll()
    await Promise.all(calls)
    context.client.dispose()
  })
}

test('explicit and default auto fall back to four workers when navigator is absent', async (t) => {
  t.after(replaceNavigator(undefined))
  for (const options of [undefined, {}, { pool: undefined }, { pool: 'auto' }] as const) {
    const context = poolContext(options)
    const calls = Array.from({ length: 6 }, () => context.client.call('hold', []))
    await context.started(6)
    assert.equal(context.workers.length, 4)
    context.resolveAll()
    await Promise.all(calls)
    context.client.dispose()
  }
})

test('explicit and default auto read hardwareConcurrency only on first call and freeze that limit', async (t) => {
  let reads = 0
  let concurrency = 2
  t.after(replaceNavigator({ get hardwareConcurrency() { reads++; return concurrency } }))
  for (const options of [undefined, {}, { pool: undefined }, { pool: 'auto' }] as const) {
    reads = 0
    concurrency = 2
    const context = poolContext(options)
    assert.equal(reads, 0, 'client construction must not read browser globals')
    concurrency = 6
    const calls = [context.client.call('hold', [])]
    assert.equal(reads, 1)
    concurrency = 100
    calls.push(...Array.from({ length: 12 }, () => context.client.call('hold', [])))
    await context.started(13)
    assert.equal(context.workers.length, 5)
    assert.equal(reads, 1)
    context.resolveAll()
    await Promise.all(calls)
    context.client.dispose()
  }
})
