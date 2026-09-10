if (typeof document !== 'undefined') {
  throw new Error('Custom RPC source was evaluated on the main thread')
}

export function inspect() {
  return {
    noDocument: typeof document === 'undefined',
    isWorker: typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope,
  }
}
