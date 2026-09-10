import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePoolQuery, poolModuleId } from '../src/pool-query.js'
import workerRpc, { type RpcPoolMode } from '../src/index.js'

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

test('project defaults preserve explicit overrides and canonical module identity', () => {
  const filename = '/compute.rpc.ts'
  const modes: RpcPoolMode[] = [1, 4, 'auto', 'unlimited']
  for (const defaultPool of modes) {
    assert.equal(parsePoolQuery(filename, defaultPool), defaultPool)
    assert.equal(parsePoolQuery(`${filename}?import&t=123`, defaultPool), defaultPool)
    assert.equal(parsePoolQuery(`${filename}?raw`, defaultPool), null)
    for (const pool of modes) {
      const id = poolModuleId(filename, pool, defaultPool)
      assert.equal(id === filename, pool === defaultPool)
      assert.equal(parsePoolQuery(`${filename}?pool=${pool}`, defaultPool), pool)
      assert.equal(parsePoolQuery(id, defaultPool), pool, 'canonical IDs must retain explicit auto overrides')
      assert.equal(poolModuleId(filename, parsePoolQuery(id, defaultPool)!, defaultPool), id)
    }
  }
})

test('validates project pool and timeout options at plugin creation', () => {
  for (const pool of [undefined, 1, 4, Number.MAX_SAFE_INTEGER, 'auto', 'unlimited'] as const) {
    assert.doesNotThrow(() => workerRpc({ pool }))
  }
  for (const pool of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, false, '4', 'AUTO']) {
    assert.throws(() => workerRpc({ pool: pool as RpcPoolMode }), /pool must be a positive safe integer/)
  }
  for (const timeoutMs of [0, 30_000, 2_147_483_647]) {
    assert.doesNotThrow(() => workerRpc({ timeoutMs }))
  }
  for (const timeoutMs of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => workerRpc({ timeoutMs }), /timeoutMs must be an integer/)
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
