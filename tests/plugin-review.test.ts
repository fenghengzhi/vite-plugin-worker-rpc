import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer, normalizePath } from 'vite'
import workerRpc from '../src/index.js'

test('dev serves worker entries from an external cacheDir without exposing its siblings', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-rpc-external-cache-app-')))
  const cacheDir = await mkdtemp(join(tmpdir(), 'worker-rpc-external-cache-'))
  const sibling = join(cacheDir, 'unrelated.txt')
  await writeFile(join(root, 'compute.rpc.ts'), 'export function add() { return 3 }')
  await writeFile(sibling, 'unrelated data')
  const server = await createServer({
    root,
    cacheDir,
    configFile: false,
    logLevel: 'silent',
    plugins: [workerRpc()],
    server: { host: '127.0.0.1', port: 0 },
  })
  try {
    await server.listen()
    const transformed = await server.transformRequest('/compute.rpc.ts')
    assert.ok(transformed)
    const entryUrl = transformed.code.match(/\/@fs\/[^"'\s]+\?worker_file&type=module/)?.[0]
    assert.ok(entryUrl, 'Vite should rewrite the Worker entry to a filesystem URL')
    const base = server.resolvedUrls!.local[0]!
    const response = await fetch(new URL(entryUrl, base))
    assert.equal(response.status, 200, 'the generated worker entry must be allowed outside root')
    assert.match(await response.text(), /exposeRpc/)

    const siblingUrl = `/@fs/${normalizePath(sibling).replace(/^\/+/, '')}`
    const siblingResponse = await fetch(new URL(siblingUrl, base))
    assert.equal(siblingResponse.status, 403, 'allowing generated entries must not expose sibling files')
  } finally {
    await server.close()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cacheDir, { recursive: true, force: true }),
    ])
  }
})
