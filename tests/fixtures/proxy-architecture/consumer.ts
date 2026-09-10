import { calculate } from '@rpc?pool=1'

export function fromOtherConsumer(value: number) {
  return calculate(value, (n: number) => n * 2)
}
