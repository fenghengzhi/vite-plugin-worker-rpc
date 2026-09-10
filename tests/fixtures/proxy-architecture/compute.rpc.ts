import { imported } from './helper'

if (typeof document !== 'undefined') throw new Error('RPC implementation executed on the main thread')

const workerId = crypto.randomUUID()

export async function calculate(value: number, callback: (n: number) => number | Promise<number>) {
  return { value: await callback(value), workerId, inWorker: typeof document === 'undefined' }
}

export { imported }
export { reexported } from './helper'
export { nested } from './nested.rpc?pool=9'
export const notCallable = 41
export class NotCallableClass {}
export function then(value: number) { return value + 100 }
export function bind(value: number) { return value + 200 }
