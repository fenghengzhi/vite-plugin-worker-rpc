import { expose, releaseProxy, wrap, type Endpoint, type Remote } from 'comlink'

/** The transport required by Comlink and the worker-side dispatcher. */
export interface RpcEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  start?(): void
}

/** A browser Worker, or a compatible transport for testing. */
export interface RpcWorker extends RpcEndpoint {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: unknown) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'error' | 'messageerror', listener: (event: unknown) => void): void
  terminate(): void
}

export type RpcPoolMode = number | 'auto' | 'unlimited'

export interface RpcClientOptions {
  /** Maximum workers, or a lazily resolved strategy. Defaults to auto. */
  pool?: RpcPoolMode
  /** Per-call timeout in milliseconds. Zero (the default) disables the timeout. */
  timeoutMs?: number
}

export interface RpcClient {
  call(method: string, args: unknown[]): Promise<unknown>
  /** Reject pending calls and terminate all workers. A disposed client cannot restart. */
  dispose(): void
}

type Dispatch = (method: string, ...args: unknown[]) => unknown
type MessageListener = (event: { data: unknown }) => void

/** Track only transport listeners; Comlink owns the entire message protocol. */
function managedEndpoint(source: RpcEndpoint): { endpoint: Endpoint; close(): void } {
  let active = true
  const listeners = new Map<EventListenerOrEventListenerObject, MessageListener>()
  return {
    endpoint: {
      postMessage(message, transfer) {
        // An exposed async call may finish after teardown. Drop that late send.
        if (active) source.postMessage(message, transfer)
      },
      addEventListener(_type, listener) {
        if (!active || listeners.has(listener)) return
        const forward: MessageListener = event => {
          if (!active) return
          if (typeof listener === 'function') listener(event as MessageEvent)
          else listener.handleEvent(event as MessageEvent)
        }
        listeners.set(listener, forward)
        source.addEventListener('message', forward)
      },
      removeEventListener(_type, listener) {
        const forward = listeners.get(listener)
        if (forward) source.removeEventListener('message', forward)
        listeners.delete(listener)
      },
      start() { if (active) source.start?.() },
    },
    close() {
      if (!active) return
      active = false
      for (const listener of listeners.values()) {
        try { source.removeEventListener('message', listener) } catch { /* Continue cleaning other listeners. */ }
      }
      listeners.clear()
    },
  }
}

interface PendingCall {
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
}

interface PoolWorker {
  worker: RpcWorker
  transport: ReturnType<typeof managedEndpoint>
  remote?: Remote<Dispatch>
  /** Includes timed-out calls until their Comlink invocation actually settles. */
  outstanding: number
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  try { return new Error(String(value)) } catch { return new Error('RPC worker failed.') }
}

/** Create a lazy Comlink-backed pool without accessing Worker or navigator. */
export function createRpcClient(
  factory: () => RpcWorker,
  { pool = 'auto', timeoutMs = 0 }: RpcClientOptions = {},
): RpcClient {
  if (pool !== 'auto' && pool !== 'unlimited' &&
      !(typeof pool === 'number' && Number.isSafeInteger(pool) && pool > 0)) {
    throw new RangeError('RPC pool must be a positive safe integer, "auto", or "unlimited".')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('RPC timeoutMs must be a finite, non-negative number.')
  }

  const workers: PoolWorker[] = []
  const pending = new Set<PendingCall>()
  let poolLimit: number | undefined
  let terminalError: Error | undefined

  function getPoolLimit(): number {
    if (poolLimit !== undefined) return poolLimit
    if (pool === 'unlimited') return poolLimit = Infinity
    if (pool !== 'auto') return poolLimit = pool
    let concurrency: unknown
    try { concurrency = globalThis.navigator?.hardwareConcurrency } catch { /* Fall back for inaccessible hosts. */ }
    return poolLimit = typeof concurrency === 'number' &&
      Number.isSafeInteger(concurrency) && concurrency > 0
      ? Math.max(1, concurrency - 1)
      : 4
  }

  function selectWorker(): PoolWorker {
    const limit = getPoolLimit()
    const idle = workers.find(candidate => candidate.outstanding === 0)
    if (idle) return idle
    if (workers.length < limit) {
      const worker = factory()
      const selected: PoolWorker = { worker, outstanding: 0, transport: managedEndpoint(worker) }
      // Retain the worker before setup so partial initialization is cleaned too.
      workers.push(selected)
      selected.remote = wrap<Dispatch>(selected.transport.endpoint)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', onMessageError)
      return selected
    }
    return workers.reduce((least, candidate) => candidate.outstanding < least.outstanding ? candidate : least)
  }

  function takePending(call: PendingCall): boolean {
    if (!pending.delete(call)) return false
    if (call.timer !== undefined) clearTimeout(call.timer)
    return true
  }

  function stop(error: Error): void {
    if (terminalError) return
    terminalError = error
    for (const call of pending) {
      takePending(call)
      call.reject(error)
    }
    for (const { worker, transport, remote } of workers.splice(0)) {
      // Comlink 4.4.2 does not remove every wrap listener on release. Close our
      // endpoint first; release then clears Comlink's bookkeeping without trying
      // to send on a failed transport. The owned Worker is terminated below.
      transport.close()
      try { remote?.[releaseProxy]() } catch { /* Continue teardown after a broken proxy. */ }
      try {
        worker.removeEventListener('error', onError)
        worker.removeEventListener('messageerror', onMessageError)
      } catch { /* A custom transport must not prevent terminating other workers. */ }
      try { worker.terminate() } catch { /* Preserve the original failure. */ }
    }
  }

  function onError(event: unknown): void {
    const failure = event as { error?: unknown; message?: unknown } | null
    stop(failure?.error instanceof Error
      ? failure.error
      : new Error(typeof failure?.message === 'string' ? failure.message : 'RPC worker failed.'))
  }

  function onMessageError(): void {
    stop(new Error('Failed to deserialize a message from the RPC worker.'))
  }

  return {
    call(method, args) {
      if (terminalError) return Promise.reject(terminalError)
      return new Promise((resolve, reject) => {
        let selected: PoolWorker
        try { selected = selectWorker() } catch (error) {
          stop(toError(error))
          reject(terminalError)
          return
        }
        const call: PendingCall = { reject }
        pending.add(call)
        selected.outstanding++
        if (timeoutMs > 0) {
          call.timer = setTimeout(() => {
            const error = new Error(`RPC call "${method}" timed out after ${timeoutMs} ms.`)
            error.name = 'TimeoutError'
            if (takePending(call)) reject(error)
          }, timeoutMs)
        }
        const complete = (settle: (value: unknown) => void, value: unknown): void => {
          selected.outstanding--
          if (takePending(call)) settle(value)
        }
        try {
          // Keep arguments separate: Comlink's proxy/transfer handlers operate
          // on each argument. The actual promise also tracks work after timeout.
          Promise.resolve(selected.remote!(method, ...args)).then(
            value => complete(resolve, value),
            error => complete(reject, error),
          )
        } catch (error) {
          complete(reject, error)
        }
      })
    },
    dispose() { stop(new Error('RPC client has been disposed.')) },
  }
}

/** Expose named functions through a callable Comlink API. */
export function exposeRpc(api: object, endpoint: RpcEndpoint = globalThis as unknown as RpcEndpoint): () => void {
  const transport = managedEndpoint(endpoint)
  // A callable dispatcher preserves exports named then/bind without using
  // Comlink's reserved proxy properties, and restricts calls to own functions.
  const dispatch: Dispatch = (method, ...args) => {
    const implementation = Object.prototype.hasOwnProperty.call(api, method)
      ? (api as Record<string, unknown>)[method]
      : undefined
    if (typeof implementation !== 'function') throw new TypeError(`RPC export "${method}" is not a function.`)
    return Reflect.apply(implementation, undefined, args)
  }
  try {
    expose(dispatch, transport.endpoint)
  } catch (error) {
    transport.close()
    throw error
  }
  return () => transport.close()
}
