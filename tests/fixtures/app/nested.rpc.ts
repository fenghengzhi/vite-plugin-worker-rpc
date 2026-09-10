if (typeof document !== 'undefined') {
  throw new Error('Nested RPC source was evaluated on the main thread')
}

export function double(value: number): number {
  return value * 2
}
