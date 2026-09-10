import { proxy, releaseProxy, type RemoteProxy } from '../../../src/client.js'

export function add(a: number, b: number): number {
  return a + b
}

export async function greet(name: string): Promise<string> {
  return `Hello, ${name}`
}

export async function applyCallback(
  callback: RemoteProxy<(value: number) => number>,
  value: number,
): Promise<number> {
  try {
    return await callback(value)
  } finally {
    callback[releaseProxy]()
  }
}

export async function applyOptionalCallback(
  value: number,
  callback?: RemoteProxy<(value: number) => number>,
): Promise<number> {
  return callback ? callback(value) : value
}

export async function applyNullableCallback(
  value: number,
  callback: RemoteProxy<(value: number) => number> | null,
): Promise<number> {
  return callback ? callback(value) : value
}

export async function applyCallbackOrValue(
  callback: RemoteProxy<(value: number) => number> | number,
): Promise<number> {
  return typeof callback === 'number' ? callback : callback(2)
}

export async function useNestedCallback(
  options: { callback: RemoteProxy<(value: number) => number> },
): Promise<number> {
  return options.callback(2)
}

export async function readProxiedObject(
  object: RemoteProxy<{ value: number; increment(amount: number): number }>,
): Promise<number> {
  try {
    const value: number = await object.value
    return await object.increment(value)
  } finally {
    object[releaseProxy]()
  }
}

export function createCounter(initial: number) {
  return proxy({
    value: initial,
    increment(amount: number) {
      this.value += amount
      return this.value
    },
  })
}

export async function createMultiplier(factor: number) {
  return proxy((value: number) => factor * value)
}

export function cloneData(value: { count: number; bytes: Uint8Array; dates: Map<string, Date> }) {
  return value
}

export function collect(first: number, label?: string, ...values: number[]): number[] {
  return [first, label?.length ?? 0, ...values]
}
