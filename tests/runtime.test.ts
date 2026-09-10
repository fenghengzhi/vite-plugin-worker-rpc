import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRpcClient, exposeRpc, type RpcEndpoint, type RpcWorker } from '../src/runtime.js'

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
