if (typeof document !== 'undefined') throw new Error('RPC dependency executed on the main thread')

export function imported(value: number) {
  return { value: value + 10, inWorker: typeof document === 'undefined' }
}

export function reexported(value: number) {
  return { value: value + 20, inWorker: typeof document === 'undefined' }
}
