import { helperVersion, useNested } from './helper'

if (typeof document !== 'undefined') {
  throw new Error('RPC source was evaluated on the main thread')
}

export interface ClonePayload {
  nested: { count: number }
  values: Map<string, number>
  created: Date
  bytes: Uint8Array
}

export type Label = string

let calls = 0

export function add(a = 1, b = 2): number {
  return a + b
}

export const counter = () => ++calls

export async function delayed(value: string, waitMs: number): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return value
}

export function echo(payload: ClonePayload): ClonePayload {
  payload.nested.count += 1
  payload.values.set('worker', 2)
  payload.bytes[0] = 42
  return payload
}

export function fail(): never {
  throw new TypeError('failure from the worker')
}

export function inspectRuntime() {
  return {
    noDocument: typeof document === 'undefined',
    isWorker: typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope,
    nested: useNested(3),
    helperVersion,
  }
}

export function sourceVersion(): string {
  return 'source:original'
}

function localName(value: number): number {
  return value * 3
}

export { localName as renamed }
