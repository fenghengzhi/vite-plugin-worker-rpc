throw new Error('The RPC implementation must not execute during SSR import')

export function add(a: number, b: number): number {
  return a + b
}
