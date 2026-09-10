// Non-function exports are intentionally valid here because this file is excluded.
export const localValue = typeof document !== 'undefined' ? 'main thread' : 'worker'
