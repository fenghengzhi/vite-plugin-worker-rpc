export function nested(value: number) {
  return { value: value + 30, inWorker: typeof document === 'undefined' }
}
