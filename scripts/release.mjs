import { appendFileSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const registry = 'https://registry.npmjs.org/'
const packageName = 'vite-plugin-worker-rpc'
const repository = 'fenghengzhi/vite-plugin-worker-rpc'
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function releaseInfo(pkg, { ref, dryRun, repo }) {
  if (repo !== repository) throw new Error(`Releases must run in ${repository}.`)
  if (pkg.name !== packageName || pkg.private === true) throw new Error('Unexpected or private npm package.')
  if (typeof pkg.version !== 'string' || !semver.test(pkg.version)) throw new Error('Invalid package version.')
  if (!dryRun && ref !== `refs/tags/v${pkg.version}`) {
    throw new Error(`Publishing requires tag v${pkg.version}, matching package.json. Use dry_run for branch checks.`)
  }
  return {
    name: pkg.name,
    version: pkg.version,
    dist_tag: pkg.version.split('+')[0].includes('-') ? 'next' : 'latest',
  }
}

export function publishedVersion(result, version) {
  if (result.error) throw result.error
  let data
  try { data = JSON.parse(result.stdout) } catch {
    throw new Error('npm returned an invalid registry response; refusing to assume the version is unpublished.')
  }
  if (result.status === 0) {
    if (data !== version) throw new Error('npm returned a different version than requested.')
    return true
  }
  if (result.status !== null && data?.error?.code === 'E404') return false
  throw new Error(`Cannot check npm version: ${data?.error?.code ?? result.status}.`)
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
  console.log(JSON.stringify(values, null, 2))
}

function run(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.error) throw result.error
  return result
}

function main(command) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  if (command === 'check') {
    if (!['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false.')
    const info = releaseInfo(pkg, {
      ref: process.env.GITHUB_REF,
      dryRun: process.env.DRY_RUN === 'true',
      repo: process.env.GITHUB_REPOSITORY,
    })
    const exists = publishedVersion(run(['view', `${info.name}@${info.version}`, 'version', '--json', `--registry=${registry}`]), info.version)
    output({ ...info, exists })
  } else if (command === 'pack') {
    const result = run(['pack', '--json'])
    if (result.status !== 0) throw new Error('npm pack failed.')
    const packs = JSON.parse(result.stdout)
    if (packs.length !== 1 || packs[0].name !== pkg.name || packs[0].version !== pkg.version) {
      throw new Error('Packed package does not match package.json.')
    }
    const pack = packs[0]
    if (basename(pack.filename) !== pack.filename || !pack.filename.endsWith('.tgz')) throw new Error('Unexpected tarball path.')
    const files = new Set(pack.files.map(file => file.path))
    for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/runtime.js', 'dist/runtime.d.ts', 'dist/pool-query.js', 'LICENSE']) {
      if (!files.has(file)) throw new Error(`Release tarball is missing ${file}.`)
    }
    output({ tarball: pack.filename })
  } else {
    throw new Error('Usage: node scripts/release.mjs check|pack')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv[2]) } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
