import type { ProxyOrClone, UnproxyOrClone } from 'comlink'

/**
 * The browser-facing shape of an RPC module. Calls use Comlink's argument and
 * return-value conversion, including explicitly proxied callbacks and objects.
 *
 * The module's exported functions are ordinary async wrappers around the pool,
 * so only returned Comlink proxies expose releaseProxy and other proxy methods.
 */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: { [I in keyof A]: UnproxyOrClone<A[I]> }) => Promise<ProxyOrClone<Awaited<R>>>
    : never
}
