import { double } from './nested.rpc?pool=auto'

export const helperVersion = 'helper:original'

export function useNested(value: number): number {
  return double(value) + 1
}
