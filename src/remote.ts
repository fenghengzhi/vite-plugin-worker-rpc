import type { ProxyMarked, ProxyOrClone, UnproxyOrClone } from 'comlink'

// Only direct function arguments are automatically proxied. Keep Comlink's
// object mapping and the callback's argument/result/property types intact.
type AutomaticCallback<T> = T extends (...args: infer A) => infer R
  ? Omit<T, keyof ProxyMarked> & ((...args: A) => R)
  : T

/**
 * The browser-facing shape of an RPC module. Calls use Comlink's argument and
 * return-value conversion. Direct callbacks are automatically proxied, while
 * proxied objects still need Comlink's explicit proxy marker.
 *
 * The module's exported functions are ordinary async wrappers around the pool,
 * so only returned Comlink proxies expose releaseProxy and other proxy methods.
 */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: { [I in keyof A]: AutomaticCallback<UnproxyOrClone<A[I]>> }) => Promise<ProxyOrClone<Awaited<R>>>
    : never
}
