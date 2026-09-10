import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePoolQuery, poolModuleId } from '../src/pool-query.js'

test('recognizes pool modes and Vite internal metadata', () => {
  assert.equal(parsePoolQuery('/compute.rpc.ts'), 'auto')
  assert.equal(parsePoolQuery('/compute.rpc.ts?import&t=123'), 'auto')
  assert.equal(parsePoolQuery('/compute.rpc.ts?pool=1'), 1)
  assert.equal(parsePoolQuery('/compute.rpc.ts?pool=12'), 12)
  assert.equal(parsePoolQuery('/compute.rpc.ts?pool=auto'), 'auto')
  assert.equal(parsePoolQuery('/compute.rpc.ts?pool=unlimited'), 'unlimited')
  assert.equal(parsePoolQuery('/compute.rpc.ts?import&pool=3&t=123'), 3)
  assert.equal(poolModuleId('/compute.rpc.ts', 1), '/compute.rpc.ts?pool=1')
  assert.equal(poolModuleId('/compute.rpc.ts', 'auto'), '/compute.rpc.ts')
})

test('preserves Vite raw, URL and Worker imports', () => {
  for (const query of ['raw', 'url', 'worker', 'sharedworker', 'worker&inline', 'worker&url', 'worker_file&type=module']) {
    assert.equal(parsePoolQuery(`/compute.rpc.ts?${query}`), null)
  }
})

test('rejects malformed pool queries instead of silently running on the main thread', () => {
  for (const query of [
    'pool', 'pool=', 'pool=0', 'pool=-1', 'pool=1.5', 'pool=01', 'pool=1e2',
    'pool=Infinity', 'pool=NaN', 'pool=AUTO', 'pool=9007199254740992',
    'pool=2&pool=3', 'pool=auto&pool=auto', 'pol=3', 'pool=3&typo=1',
    'pool=1&raw', 'worker&pool=4',
  ]) {
    assert.throws(() => parsePoolQuery(`/compute.rpc.ts?${query}`), /vite-plugin-worker-rpc/)
  }
})
