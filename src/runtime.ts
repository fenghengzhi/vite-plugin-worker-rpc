/** The message transport required by the worker-side RPC server. */
export interface RpcEndpoint {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
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
  /** Maximum workers, or a lazily resolved strategy. Defaults to one worker. */
  pool?: RpcPoolMode
  /** Per-call timeout in milliseconds. Zero (the default) disables the timeout. */
  timeoutMs?: number
}

export interface RpcClient {
  call(method: string, args: unknown[]): Promise<unknown>
  /** Reject pending calls and terminate all workers. A disposed client cannot restart. */
  dispose(): void
}

const protocol = 'vite-plugin-worker-rpc/v1'

interface SerializedError {
  name: string
  message: string
  stack?: string
}

interface PendingCall {
  resolve(value: unknown): void
  reject(reason: Error): void
  timer?: ReturnType<typeof setTimeout>
}

interface PoolWorker {
  worker: RpcWorker
  /** Includes timed-out calls until their actual response arrives. */
  outstanding: Set<number>
  onMessage(event: { data: unknown }): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function serializeError(value: unknown): SerializedError {
  try {
    if (isRecord(value) && typeof value.message === 'string') {
      return {
        name: typeof value.name === 'string' ? value.name : 'Error',
        message: value.message,
        ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
      }
    }
    return { name: 'Error', message: String(value) }
  } catch {
    return { name: 'Error', message: 'Unknown RPC error' }
  }
}

function deserializeError(value: SerializedError): Error {
  const error = new Error(value.message)
  error.name = value.name
  if (value.stack !== undefined) error.stack = value.stack
  return error
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : deserializeError(serializeError(value))
}

/**
 * Create a lazy RPC pool. Importing this module or creating a client does not
 * access Worker or navigator, so generated modules can also be imported during SSR.
 */
export function createRpcClient(
  factory: () => RpcWorker,
  { pool = 1, timeoutMs = 0 }: RpcClientOptions = {},
): RpcClient {
  if (pool !== 'auto' && pool !== 'unlimited' &&
      !(typeof pool === 'number' && Number.isSafeInteger(pool) && pool > 0)) {
    throw new RangeError('RPC pool must be a positive safe integer, "auto", or "unlimited".')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('RPC timeoutMs must be a finite, non-negative number.')
  }

  const workers: PoolWorker[] = []
  let poolLimit: number | undefined
  let terminalError: Error | undefined
  let nextId = 0
  const pending = new Map<number, PendingCall>()

  function getPoolLimit(): number {
    if (poolLimit !== undefined) return poolLimit
    if (pool === 'unlimited') return poolLimit = Infinity
    if (pool !== 'auto') return poolLimit = pool

    let concurrency: unknown
    try {
      concurrency = globalThis.navigator?.hardwareConcurrency
    } catch {
      // Some hosts expose an inaccessible navigator; use the same fallback.
    }
    return poolLimit = typeof concurrency === 'number' &&
      Number.isSafeInteger(concurrency) && concurrency > 0
      ? Math.max(1, concurrency - 1)
      : 4
  }

  function selectWorker(): PoolWorker {
    const limit = getPoolLimit()
    const idle = workers.find(candidate => candidate.outstanding.size === 0)
    if (idle) return idle
    if (workers.length < limit) {
      const worker = factory()
      const selected: PoolWorker = {
        worker,
        outstanding: new Set(),
        onMessage: event => onMessage(selected, event),
      }
      workers.push(selected)
      worker.addEventListener('message', selected.onMessage)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', onMessageError)
      return selected
    }
    return workers.reduce((least, candidate) =>
      candidate.outstanding.size < least.outstanding.size ? candidate : least,
    )
  }

  function takePending(id: number): PendingCall | undefined {
    const call = pending.get(id)
    if (call) {
      pending.delete(id)
      if (call.timer !== undefined) clearTimeout(call.timer)
    }
    return call
  }

  function stop(error: Error): void {
    if (terminalError) return
    terminalError = error
    for (const id of pending.keys()) takePending(id)?.reject(error)

    for (const { worker, outstanding, onMessage } of workers.splice(0)) {
      outstanding.clear()
      try {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        worker.removeEventListener('messageerror', onMessageError)
      } catch {
        // A broken custom transport must not prevent terminating the other workers.
      }
      try {
        worker.terminate()
      } catch {
        // Preserve the original failure and continue cleaning up the whole pool.
      }
    }
  }

  function onMessage(source: PoolWorker, event: { data: unknown }): void {
    const message = event.data
    if (
      !isRecord(message) || message.rpc !== protocol || message.type !== 'response' ||
      typeof message.id !== 'number' || !Number.isSafeInteger(message.id) ||
      !source.outstanding.has(message.id)
    ) return

    if (message.ok === true) {
      source.outstanding.delete(message.id)
      takePending(message.id)?.resolve(message.value)
    } else if (
      message.ok === false && isRecord(message.error) &&
      typeof message.error.name === 'string' && typeof message.error.message === 'string'
    ) {
      const error = deserializeError({
        name: message.error.name,
        message: message.error.message,
        ...(typeof message.error.stack === 'string' ? { stack: message.error.stack } : {}),
      })
      source.outstanding.delete(message.id)
      takePending(message.id)?.reject(error)
    }
  }

  function onError(event: unknown): void {
    const error = isRecord(event) && event.error instanceof Error
      ? event.error
      : new Error(isRecord(event) && typeof event.message === 'string'
        ? event.message
        : 'RPC worker failed.')
    stop(error)
  }

  function onMessageError(): void {
    stop(new Error('Failed to deserialize a message from the RPC worker.'))
  }

  return {
    call(method, args) {
      if (terminalError) return Promise.reject(terminalError)

      return new Promise((resolve, reject) => {
        let selected: PoolWorker
        try {
          selected = selectWorker()
        } catch (error) {
          stop(toError(error))
          reject(terminalError)
          return
        }

        const id = ++nextId
        const call: PendingCall = { resolve, reject }
        pending.set(id, call)
        selected.outstanding.add(id)
        if (timeoutMs > 0) {
          call.timer = setTimeout(() => {
            const error = new Error(`RPC call "${method}" timed out after ${timeoutMs} ms.`)
            error.name = 'TimeoutError'
            takePending(id)?.reject(error)
          }, timeoutMs)
        }

        try {
          selected.worker.postMessage({ rpc: protocol, type: 'request', id, method, args })
        } catch (error) {
          // An uncloneable argument fails only this call; the worker remains usable.
          selected.outstanding.delete(id)
          takePending(id)?.reject(toError(error))
        }
      })
    },
    dispose() {
      stop(new Error('RPC client has been disposed.'))
    },
  }
}

/** Expose a module's own function exports to RPC calls in a dedicated worker. */
export function exposeRpc(
  api: object,
  endpoint: RpcEndpoint = globalThis as unknown as RpcEndpoint,
): () => void {
  let active = true

  function sendError(id: number, error: unknown): void {
    if (!active) return
    try {
      endpoint.postMessage({
        rpc: protocol, type: 'response', id, ok: false, error: serializeError(error),
      })
    } catch {
      // The endpoint may already be closed. Never produce an unhandled rejection.
    }
  }

  async function invoke(id: number, method: string, args: unknown[]): Promise<void> {
    try {
      const implementation = Object.prototype.hasOwnProperty.call(api, method)
        ? (api as Record<string, unknown>)[method]
        : undefined
      if (typeof implementation !== 'function') {
        throw new TypeError(`RPC export "${method}" is not a function.`)
      }
      const value: unknown = await Reflect.apply(implementation, undefined, args)
      if (active) {
        // postMessage can itself fail when the function returns an uncloneable value.
        endpoint.postMessage({ rpc: protocol, type: 'response', id, ok: true, value })
      }
    } catch (error) {
      sendError(id, error)
    }
  }

  function onMessage(event: { data: unknown }): void {
    const message = event.data
    if (
      !isRecord(message) || message.rpc !== protocol || message.type !== 'request' ||
      typeof message.id !== 'number' || !Number.isSafeInteger(message.id) ||
      typeof message.method !== 'string' || !Array.isArray(message.args)
    ) return
    void invoke(message.id, message.method, message.args)
  }

  endpoint.addEventListener('message', onMessage)
  return () => {
    active = false
    endpoint.removeEventListener('message', onMessage)
  }
}
