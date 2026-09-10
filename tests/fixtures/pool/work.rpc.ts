import { helperVersion, useNested } from './helper'

if (typeof document !== 'undefined') {
  throw new Error('Pooled RPC source ran on the main thread')
}

const id = crypto.randomUUID()
let active = 0

export function run(label: string) {
  return {
    id,
    label,
    active,
    isWorker: typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope,
    nested: useNested(2),
    sourceVersion: 'source:original',
    helperVersion,
  }
}

export async function hold(label: string, channelName: string) {
  const channel = new BroadcastChannel(channelName)
  const released = new Promise<void>((resolve) => {
    channel.onmessage = () => resolve()
  })
  active += 1
  const activeAtStart = active
  postMessage({ kind: 'pool-test-start', id, label, activeAtStart })
  try {
    await released
    return { ...run(label), activeAtStart }
  } finally {
    active -= 1
    channel.close()
  }
}
