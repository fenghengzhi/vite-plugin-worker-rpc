export { proxy, transfer, releaseProxy, transferHandlers } from 'comlink'
export type { ProxyMarked, TransferHandler } from 'comlink'

import type { ProxyMarked, Remote as ComlinkRemote } from 'comlink'

/** A proxied value as seen by its receiver, including Comlink's proxy marker. */
export type RemoteProxy<T> = ComlinkRemote<T & ProxyMarked>
