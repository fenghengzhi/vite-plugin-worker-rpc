import { proxy, releaseProxy, transfer, transferHandlers } from 'vite-plugin-worker-rpc/client'
import { CustomValue, sharedHandlers } from './value'

if (typeof document !== 'undefined') throw new Error('RPC implementation executed on the main thread')

const workerId = crypto.randomUUID()
let lastTransferred: ArrayBuffer | undefined

export async function callbackValue(callback: (value: number, worker: string) => number | Promise<number>, value: number) {
  const result = { value: 0, workerId, released: false }
  try {
    result.value = await callback(value, workerId)
    return result
  } finally {
    callback[releaseProxy]()
    try {
      callback(0, workerId)
    } catch (error) {
      result.released = error instanceof Error && /released/.test(error.message)
    }
  }
}

export function retainCallback(callback: (value: number) => Promise<number>) {
  return proxy({
    async call(value: number) { return await callback(value) },
    dispose() { callback[releaseProxy]() },
  })
}

export async function nestedCallbackValue(options: { callback: (value: number) => number }, value: number) {
  return await options.callback(value)
}

export function transferBuffer(buffer: ArrayBuffer) {
  new Uint8Array(buffer)[0] += 1
  lastTransferred = buffer
  return transfer(buffer, [buffer])
}

export function transferredLength() {
  return lastTransferred?.byteLength
}

export function copyBuffer(buffer: ArrayBuffer) {
  new Uint8Array(buffer)[0] += 1
  return buffer
}

export function returnFunction(base: number) {
  return proxy((value: number) => base + value)
}

export function roundTripCustom(value: CustomValue) {
  if (!(value instanceof CustomValue)) throw new TypeError('Custom transfer handler did not deserialize the argument')
  if (transferHandlers !== sharedHandlers) throw new Error('Public helpers loaded more than once')
  return new CustomValue(value.double())
}

export function customFunctionValue(callback: (value: number) => number, value: number) {
  const result = callback(value)
  if (typeof result !== 'number') throw new Error('Custom function handler did not deserialize a local function')
  return result
}

// Both names have special meanings to Comlink's generic proxy. The plugin's
// invocation adapter must preserve them as ordinary named RPC exports.
export function then(value: number) { return value + 100 }
export function bind(value: number) { return value + 200 }
