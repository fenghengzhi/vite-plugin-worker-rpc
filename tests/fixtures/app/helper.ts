import { double } from './nested.rpc'

export const helperVersion = 'helper:original'

export function useNested(value: number): number {
  // A helper imported by the worker must see ordinary local RPC exports.
  // If this import accidentally creates another proxy, the result is wrong.
  return double(value) + 1
}
