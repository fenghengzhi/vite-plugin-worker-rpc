import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRpcClient, exposeRpc, type RpcClientOptions, type RpcEndpoint, type RpcWorker } from '../src/runtime.js'

type Listener = (event: never) => void

class FakePort {
  peer?: FakePort
  messages: unknown[] = []
  listeners = new Map<string, Set<Listener>>()
  terminated = 0

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

  postMessage(message: unknown): void {
    const cloned = structuredClone(message)
    this.messages.push(cloned)
    queueMicrotask(() => this.peer?.emit('message', { data: cloned }))
  }

  terminate(): void {
    this.terminated++
  }
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
  }, options)
  return { worker, server, client, cleanup, get created() { return created } }
}

function poolContext(options: RpcClientOptions = {}) {
  const workers: FakePort[] = []
  const client = createRpcClient(() => {
    const worker = new FakePort()
    workers.push(worker)
    return worker as unknown as RpcWorker
  }, options)
  function response(workerIndex: number, requestIndex: number, value: unknown = 'done') {
    const request = workers[workerIndex]!.messages[requestIndex] as Record<string, unknown>
    return { ...request, type: 'response', ok: true, value }
  }
  function reply(workerIndex: number, requestIndex: number, value?: unknown) {
    workers[workerIndex]!.emit('message', { data: response(workerIndex, requestIndex, value) })
  }
  function replyAll() {
    for (const [workerIndex, worker] of workers.entries()) {
      for (let requestIndex = 0; requestIndex < worker.messages.length; requestIndex++) {
        reply(workerIndex, requestIndex)
      }
    }
  }
  return { client, workers, response, reply, replyAll }
}

function replaceNavigator(value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
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
  const finish = new Map<string, (value: string) => void>()
  const context = pair({ hold: (key: string) => new Promise<string>(resolve => finish.set(key, resolve)) })
  const first = context.client.call('hold', ['first'])
  const second = context.client.call('hold', ['second'])
  await Promise.resolve()
  finish.get('second')!('two')
  assert.equal(await second, 'two')
  finish.get('first')!('one')
  assert.equal(await first, 'one')
  const ids = context.worker.messages.map(message => (message as { id: number }).id)
  assert.equal(new Set(ids).size, 2)
  context.client.dispose()
})

test('serializes sync throws, async rejections, and non-Error thrown values', async () => {
  const context = pair({
    fail() { throw new RangeError('outside range') },
    async reject() { throw new TypeError('bad input') },
    throwString() { throw 'plain failure' },
    throwUnserializable() { throw Object.create(null) },
  })
  await assert.rejects(context.client.call('fail', []), error => {
    assert.equal((error as Error).name, 'RangeError')
    assert.equal((error as Error).message, 'outside range')
    assert.match((error as Error).stack!, /runtime\.test\.ts/)
    return true
  })
  await assert.rejects(context.client.call('reject', []), { name: 'TypeError', message: 'bad input' })
  await assert.rejects(context.client.call('throwString', []), /plain failure/)
  await assert.rejects(context.client.call('throwUnserializable', []), /Unknown RPC error/)
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
  await assert.rejects(context.client.call('badResult', []), { name: 'DataCloneError' })
  const original = { date: new Date(0), map: new Map([['answer', 42]]) }
  const result = await context.client.call('echo', [original])
  assert.deepEqual(result, original)
  assert.notEqual(result, original)
  assert.equal(context.created, 1)
  context.client.dispose()
})

test('ignores unrelated messages and malformed protocol responses', async () => {
  let finish!: (value: number) => void
  const context = pair({ hold: () => new Promise<number>(resolve => { finish = resolve }) })
  const result = context.client.call('hold', [])
  const request = context.worker.messages[0] as Record<string, unknown>
  context.worker.emit('message', { data: { ...request, type: 'response', rpc: 'other', ok: true, value: 999 } })
  context.worker.emit('message', { data: { ...request, type: 'response', ok: false, error: null } })
  context.worker.emit('message', { data: { ...request, type: 'response', id: 999, ok: true, value: 999 } })
  context.server.emit('message', { data: { ...request, rpc: 'other' } })
  await Promise.resolve()
  finish(42)
  assert.equal(await result, 42)
  assert.equal(context.server.messages.length, 1)
  context.client.dispose()
})

test('dispose rejects all pending and future calls and removes listeners', async () => {
  const context = pair({ hold: () => new Promise(() => {}) })
  const first = assert.rejects(context.client.call('hold', []), /disposed/)
  const second = assert.rejects(context.client.call('hold', []), /disposed/)
  context.client.dispose()
  await Promise.all([first, second])
  await assert.rejects(context.client.call('hold', []), /disposed/)
  context.client.dispose()
  assert.equal(context.worker.terminated, 1)
  for (const listeners of context.worker.listeners.values()) assert.equal(listeners.size, 0)
})

test('disposing an unused client never creates a worker', async () => {
  const context = pair({})
  context.client.dispose()
  await assert.rejects(context.client.call('anything', []), /disposed/)
  assert.equal(context.created, 0)
})

for (const event of ['error', 'messageerror']) {
  test(`worker ${event} rejects pending and future calls and terminates once`, async () => {
    const context = pair({ hold: () => new Promise(() => {}) })
    const expected = event === 'error' ? /worker crashed/ : /deserialize/
    const first = assert.rejects(context.client.call('hold', []), expected)
    const second = assert.rejects(context.client.call('hold', []), expected)
    context.worker.emit(event, { message: 'worker crashed' })
    await Promise.all([first, second])
    await assert.rejects(context.client.call('hold', []), expected)
    context.client.dispose()
    assert.equal(context.worker.terminated, 1)
    assert.equal(context.created, 1)
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

test('timeout rejects only the timed out call and ignores a late response', async () => {
  let finish!: (value: number) => void
  const context = pair({
    hold: () => new Promise<number>(resolve => { finish = resolve }),
    add: (a: number, b: number) => a + b,
  }, { timeoutMs: 20 })
  await assert.rejects(context.client.call('hold', []), { name: 'TimeoutError' })
  finish(42)
  assert.equal(await context.client.call('add', [2, 3]), 5)
  assert.equal(context.created, 1)
  context.client.dispose()
})

test('validates timeout options', () => {
  for (const timeoutMs of [-1, NaN, Infinity]) {
    assert.throws(() => createRpcClient(() => new FakePort() as unknown as RpcWorker, { timeoutMs }), RangeError)
  }
})

test('server cleanup removes its listener and suppresses an in-flight response', async () => {
  let finish!: (value: number) => void
  const context = pair({ hold: () => new Promise<number>(resolve => { finish = resolve }) })
  const rejection = assert.rejects(context.client.call('hold', []), /disposed/)
  await Promise.resolve()
  context.cleanup()
  finish(42)
  await Promise.resolve()
  assert.equal(context.server.messages.length, 0)
  assert.equal(context.server.listeners.get('message')?.size, 0)
  context.client.dispose()
  await rejection
})

for (const pool of [1, 2, 3]) {
  test(`pool=${pool} dispatches all calls immediately without exceeding the ceiling`, async () => {
    const context = poolContext({ pool })
    assert.equal(context.workers.length, 0)
    const calls = Array.from({ length: 11 }, (_, index) => context.client.call('hold', [index]))
    assert.equal(context.workers.length, pool)
    const counts = context.workers.map(worker => worker.messages.length)
    assert.equal(counts.reduce((sum, value) => sum + value, 0), 11, 'calls must not enter a main-thread queue')
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1)
    context.replyAll()
    await Promise.all(calls)
    context.client.dispose()
  })
}

test('finite pools reuse idle workers before creating another', async () => {
  const context = poolContext({ pool: 3 })
  const first = context.client.call('hold', [])
  context.reply(0, 0)
  await first
  const second = context.client.call('hold', [])
  assert.equal(context.workers.length, 1)
  const third = context.client.call('hold', [])
  assert.equal(context.workers.length, 2)
  context.reply(0, 1)
  await second
  const fourth = context.client.call('hold', [])
  assert.equal(context.workers.length, 2, 'an idle worker should prevent unnecessary growth')
  assert.equal(context.workers[0]!.messages.length, 3)
  context.replyAll()
  await Promise.all([third, fourth])
  context.client.dispose()
})

test('a full pool dispatches to the worker with the fewest actual outstanding calls', async () => {
  const context = poolContext({ pool: 3 })
  const calls = Array.from({ length: 7 }, () => context.client.call('hold', []))
  assert.deepEqual(context.workers.map(worker => worker.messages.length), [3, 2, 2])
  context.reply(1, 0)
  calls.push(context.client.call('hold', ['least-loaded']))
  assert.deepEqual(context.workers.map(worker => worker.messages.length), [3, 3, 2])
  assert.deepEqual((context.workers[1]!.messages[2] as { args: unknown[] }).args, ['least-loaded'])
  context.replyAll()
  await Promise.all(calls)
  context.client.dispose()
})

test('unlimited grows to peak concurrency and reuses retained workers', async () => {
  const context = poolContext({ pool: 'unlimited' })
  const firstBurst = Array.from({ length: 32 }, () => context.client.call('hold', []))
  assert.equal(context.workers.length, 32)
  context.replyAll()
  await Promise.all(firstBurst)
  assert.ok(context.workers.every(worker => worker.terminated === 0))
  const secondBurst = Array.from({ length: 9 }, () => context.client.call('hold', []))
  assert.equal(context.workers.length, 32)
  context.replyAll()
  await Promise.all(secondBurst)
  context.client.dispose()
  assert.ok(context.workers.every(worker => worker.terminated === 1))
})

test('wrong-worker, duplicate and malformed replies do not settle calls or alter pool occupancy', async () => {
  const context = poolContext({ pool: 'unlimited' })
  const first = context.client.call('hold', [])
  const second = context.client.call('hold', [])
  let firstSettled = false
  void first.then(() => { firstSettled = true })
  context.workers[1]!.emit('message', { data: context.response(0, 0, 'wrong worker') })
  context.workers[0]!.emit('message', { data: { ...context.response(0, 0), ok: false, error: null } })
  await Promise.resolve()
  assert.equal(firstSettled, false)
  const third = context.client.call('hold', [])
  assert.equal(context.workers.length, 3, 'invalid responses must not make a worker idle')
  context.reply(0, 0, 'correct worker')
  assert.equal(await first, 'correct worker')
  const fourth = context.client.call('hold', [])
  assert.equal(context.workers.length, 3)
  context.reply(0, 0, 'duplicate')
  const fifth = context.client.call('hold', [])
  assert.equal(context.workers.length, 4, 'a duplicate must not clear the newer request on its worker')
  context.replyAll()
  await Promise.all([second, third, fourth, fifth])
  context.client.dispose()
})

test('timeouts retain actual worker occupancy until a matching late reply', async () => {
  const context = poolContext({ pool: 'unlimited', timeoutMs: 20 })
  await assert.rejects(context.client.call('hold', []), { name: 'TimeoutError' })
  const second = context.client.call('hold', [])
  assert.equal(context.workers.length, 2, 'a timed-out computation is still busy')
  context.reply(0, 0)
  const third = context.client.call('hold', [])
  assert.equal(context.workers.length, 2, 'the late reply makes that worker reusable')
  assert.equal(context.workers[0]!.messages.length, 2)
  context.reply(0, 0)
  const fourth = context.client.call('hold', [])
  assert.equal(context.workers.length, 3, 'duplicate late replies must not release newer work')
  context.replyAll()
  await Promise.all([second, third, fourth])
  context.client.dispose()
})

test('argument clone errors release pool occupancy immediately', async () => {
  const context = poolContext({ pool: 'unlimited' })
  await assert.rejects(context.client.call('echo', [() => 1]), { name: 'DataCloneError' })
  const next = context.client.call('echo', [42])
  assert.equal(context.workers.length, 1)
  context.reply(0, 0, 42)
  assert.equal(await next, 42)
  context.client.dispose()
})

test('dispose rejects every pooled call and terminates every worker once', async () => {
  const context = poolContext({ pool: 3 })
  const rejections = Array.from({ length: 8 }, () =>
    assert.rejects(context.client.call('hold', []), /disposed/),
  )
  context.client.dispose()
  await Promise.all(rejections)
  context.client.dispose()
  await assert.rejects(context.client.call('hold', []), /disposed/)
  assert.equal(context.workers.length, 3)
  for (const worker of context.workers) {
    assert.equal(worker.terminated, 1)
    for (const listeners of worker.listeners.values()) assert.equal(listeners.size, 0)
  }
})

for (const event of ['error', 'messageerror']) {
  test(`one pooled worker ${event} rejects all calls and terminates the entire pool`, async () => {
    const context = poolContext({ pool: 3 })
    const expected = event === 'error' ? /pool worker crashed/ : /deserialize/
    const rejections = Array.from({ length: 6 }, () =>
      assert.rejects(context.client.call('hold', []), expected),
    )
    context.workers[1]!.emit(event, { message: 'pool worker crashed' })
    await Promise.all(rejections)
    await assert.rejects(context.client.call('hold', []), expected)
    assert.ok(context.workers.every(worker => worker.terminated === 1))
    context.client.dispose()
  })
}

test('a pool expansion failure also terminates previously created workers', async () => {
  const worker = new FakePort()
  let attempts = 0
  const client = createRpcClient(() => {
    if (++attempts > 1) throw new Error('cannot create another worker')
    return worker as unknown as RpcWorker
  }, { pool: 2 })
  const first = assert.rejects(client.call('hold', []), /cannot create another worker/)
  await assert.rejects(client.call('hold', []), /cannot create another worker/)
  await first
  assert.equal(worker.terminated, 1)
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
    assert.equal(context.workers.length, expected)
    context.replyAll()
    await Promise.all(calls)
    context.client.dispose()
  })
}

test('auto falls back to four workers when navigator is absent', async (t) => {
  t.after(replaceNavigator(undefined))
  const context = poolContext({ pool: 'auto' })
  const calls = Array.from({ length: 6 }, () => context.client.call('hold', []))
  assert.equal(context.workers.length, 4)
  context.replyAll()
  await Promise.all(calls)
  context.client.dispose()
})

test('auto reads hardwareConcurrency only on first call and freezes that limit', async (t) => {
  let reads = 0
  let concurrency = 2
  t.after(replaceNavigator({ get hardwareConcurrency() { reads++; return concurrency } }))
  const context = poolContext({ pool: 'auto' })
  assert.equal(reads, 0, 'client construction must not read browser globals')
  concurrency = 6
  const calls = [context.client.call('hold', [])]
  assert.equal(reads, 1)
  concurrency = 100
  calls.push(...Array.from({ length: 12 }, () => context.client.call('hold', [])))
  assert.equal(context.workers.length, 5)
  assert.equal(reads, 1)
  context.replyAll()
  await Promise.all(calls)
  context.client.dispose()
})
