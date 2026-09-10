if (typeof document !== 'undefined') {
  throw new Error('JavaScript RPC source was evaluated on the main thread')
}

export const subtract = (a, b) => a - b
