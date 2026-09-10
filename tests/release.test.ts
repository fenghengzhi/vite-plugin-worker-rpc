import assert from 'node:assert/strict'
import { test } from 'node:test'

const { releaseInfo, publishedVersion } = await import(new URL('../scripts/release.mjs', import.meta.url).href)
const pkg = { name: 'vite-plugin-worker-rpc', version: '0.2.0' }
const context = { repo: 'fenghengzhi/vite-plugin-worker-rpc', ref: 'refs/tags/v0.2.0', dryRun: false }

test('release metadata requires a matching version tag and selects stable versus prerelease tags', () => {
  assert.deepEqual(releaseInfo(pkg, context), { name: pkg.name, version: '0.2.0', dist_tag: 'latest' })
  const preview = { ...pkg, version: '0.3.0-beta.1' }
  assert.equal(releaseInfo(preview, { ...context, ref: 'refs/tags/v0.3.0-beta.1' }).dist_tag, 'next')
  for (const ref of ['refs/heads/main', 'refs/tags/v0.1.0', 'refs/tags/0.2.0']) {
    assert.throws(() => releaseInfo(pkg, { ...context, ref }), /matching package.json/)
  }
  assert.equal(releaseInfo(pkg, { ...context, ref: 'refs/heads/main', dryRun: true }).version, '0.2.0')
})

test('release metadata refuses unrelated repositories and unexpected package identities', () => {
  assert.throws(() => releaseInfo(pkg, { ...context, repo: 'someone/another-repo' }), /Releases must run/)
  assert.throws(() => releaseInfo({ ...pkg, name: 'another-package' }, context), /Unexpected/)
  assert.throws(() => releaseInfo({ ...pkg, private: true }, context), /private/)
  assert.throws(() => releaseInfo({ ...pkg, version: '0.2.0\nextra=value' }, context), /Invalid/)
})

test('registry lookup only considers a genuine E404 unpublished', () => {
  assert.equal(publishedVersion({ status: 0, stdout: '"0.2.0"' }, '0.2.0'), true)
  assert.equal(publishedVersion({ status: 1, stdout: '{"error":{"code":"E404"}}' }, '0.2.0'), false)
  for (const code of ['E403', 'E401', 'E500', 'ENOTFOUND']) {
    assert.throws(() => publishedVersion({ status: 1, stdout: JSON.stringify({ error: { code } }) }, '0.2.0'), /Cannot check/)
  }
  assert.throws(() => publishedVersion({ status: 1, stdout: '' }, '0.2.0'), /invalid registry/)
  assert.throws(() => publishedVersion({ status: 0, stdout: '"0.1.0"' }, '0.2.0'), /different version/)
})
