import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer, normalizePath } from 'vite'
import workerRpc from '../src/index.js'

test('dev serves worker entries from an external cacheDir without exposing its siblings', { timeout: 15_000 }, async () => {
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
    // This filesystem-access test does not edit files. Disable watching so
    // Vite 6/7 cannot retain late-starting watchers during concurrent teardown.
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  // Own the HTTP lifecycle so Vite does not attach CLI stdin listeners in this
  // Node test process. The same Vite filesystem middleware handles requests.
  const httpServer = createHttpServer(server.middlewares)
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.off('error', reject)
        resolve()
      })
    })
    const transformed = await server.transformRequest('/compute.rpc.ts')
    assert.ok(transformed)
    const entryUrl = transformed.code.match(/\/@fs\/[^"'\s]+\?worker_file&type=module/)?.[0]
    assert.ok(entryUrl, 'Vite should rewrite the Worker entry to a filesystem URL')
    const address = httpServer.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}/`
    const response = await fetch(new URL(entryUrl, base), { headers: { connection: 'close' } })
    assert.equal(response.status, 200, 'the generated worker entry must be allowed outside root')
    assert.match(await response.text(), /exposeRpc/)

    const siblingUrl = `/@fs/${normalizePath(sibling).replace(/^\/+/, '')}`
    const siblingResponse = await fetch(new URL(siblingUrl, base), { headers: { connection: 'close' } })
    await siblingResponse.text()
    assert.equal(siblingResponse.status, 403, 'allowing generated entries must not expose sibling files')
  } finally {
    httpServer.closeAllConnections()
    await Promise.all([
      server.close(),
      new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) return resolve()
        httpServer.close((error) => error ? reject(error) : resolve())
      }),
    ])
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cacheDir, { recursive: true, force: true }),
    ])
  }
})
