import type { RpcPoolMode } from './runtime.js'

// Queries handled by Vite itself must not turn a Worker entry or raw asset
// into an RPC proxy. They cannot be combined with a pool request.
const assetQueries = new Set(['raw', 'url', 'worker', 'sharedworker', 'inline', 'worker_file'])
const internalQueries = new Set(['t', 'v', 'import'])

/** null denotes a Vite asset request, not an RPC import. */
export function parsePoolQuery(id: string): RpcPoolMode | null {
  const index = id.indexOf('?')
  if (index < 0) return 1
  const params = new URLSearchParams(id.slice(index + 1))
  const fail = (reason: string): never => {
    throw new Error(`[vite-plugin-worker-rpc] ${id}: ${reason} Use ?pool=1, ?pool=N, ?pool=auto or ?pool=unlimited.`)
  }
  const values = params.getAll('pool')
  const keys = [...params.keys()]
  if (values.length > 1) fail('The pool parameter must occur only once.')
  if (keys.some(key => assetQueries.has(key))) {
    if (values.length) fail('pool cannot be combined with a Vite asset or Worker query.')
    return null
  }
  for (const key of keys) {
    if (key !== 'pool' && !internalQueries.has(key)) fail(`Unknown RPC parameter "${key}".`)
  }
  if (!values.length) return 1
  const value = values[0]!
  if (value === 'auto' || value === 'unlimited') return value
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    fail('pool must be a positive safe integer, auto or unlimited.')
  }
  return Number(value)
}

/** Omitted pool and pool=1 intentionally resolve to the same ESM module. */
export function poolModuleId(filename: string, pool: RpcPoolMode): string {
  return pool === 1 ? filename : `${filename}?pool=${pool}`
}
