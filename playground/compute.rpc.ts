export interface ComputeResult {
  sum: number
  iterations: number
  elapsedMs: number
  inWorker: boolean
}

// The function is async so TypeScript sees the same Promise returned by RPC.
// Its CPU-bound loop runs entirely in the Worker.
export async function compute(durationMs = 1_200): Promise<ComputeResult> {
  const duration = Math.max(100, Math.min(5_000, durationMs))
  const started = performance.now()
  let iterations = 0
  let sum = 0

  do {
    for (let i = 0; i < 100_000; i++) {
      sum += i % 97
    }
    iterations += 100_000
  } while (performance.now() - started < duration)

  return {
    sum,
    iterations,
    elapsedMs: performance.now() - started,
    inWorker: typeof document === 'undefined',
  }
}
