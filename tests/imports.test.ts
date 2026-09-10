import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from '@babel/parser'
import { rewriteRpcImports } from '../src/imports.js'

const isRpc = async (source: string) => source.includes('.rpc') || source === '@compute'
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
const wrapper = dataUrl(`
  const functions = new Map();
  const api = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (!functions.has(name)) functions.set(name, (...args) => ({ name, args }));
      return functions.get(name);
    }
  });
  export default api;
  export const __workerRpcNamespace = new Proxy(api, {
    get(target, key) { return key === 'then' ? undefined : target[key] }
  });
`)

async function execute(code: string): Promise<any> {
  const transformed = await rewriteRpcImports(code, 'consumer.js', async source => source === wrapper)
  return import(dataUrl(transformed?.code ?? code))
}

test('rewrites named RPC imports and aliases without inspecting RPC exports', async () => {
  const source = `import { add, subtract as minus } from './compute.rpc?pool=2';\nadd(1, minus(3, 2));`
  const transformed = await rewriteRpcImports(source, 'main.ts', isRpc)
  assert.ok(transformed)
  assert.match(transformed.code, /import __worker_rpc_0 from '\.\/compute\.rpc\?pool=2'/)
  assert.match(transformed.code, /const add = __worker_rpc_0\["add"\]/)
  assert.match(transformed.code, /const minus = __worker_rpc_0\["subtract"\]/)
  assert.deepEqual(transformed.map.sources, ['main.ts'])
  assert.deepEqual(transformed.map.sourcesContent, [source])
  assert.ok(transformed.map.mappings.length)
})

test('leaves unrelated imports, side-effect imports and type-only imports unchanged', async () => {
  const source = `
    import { add } from './ordinary';
    import './compute.rpc';
    import type { Value } from './compute.rpc';
    import { type Input } from './compute.rpc';
    export type { Value } from './compute.rpc';
    export { type Input } from './compute.rpc';
    export type * from './compute.rpc';
    const local = import('./ordinary');
  `
  assert.equal(await rewriteRpcImports(source, 'main.ts', isRpc), null)
})

test('retains mixed type specifiers, comments, and string-named exports', async () => {
  const source = `
    import { /* before */ add as plus, type Input as Shape, "custom-name" as custom /* after */ } from '@compute';
    export { add as "public-name", type Input as Shape } from './compute.rpc';
  `
  const transformed = await rewriteRpcImports(source, 'main.ts', isRpc)
  assert.ok(transformed)
  parse(transformed.code, { sourceType: 'module', plugins: ['typescript'] })
  assert.match(transformed.code, /type Input as Shape/)
  assert.match(transformed.code, /\["custom-name"\]/)
  assert.match(transformed.code, /as "public-name"/)
  assert.equal(transformed.code.match(/\/\* before \*\//g)?.length, 1)
  assert.equal(transformed.code.match(/\/\* after \*\//g)?.length, 1)
})

test('makes default and namespace imports non-thenable while preserving explicitly named then', async () => {
  const module = await execute(`
    import api, * as ns from ${JSON.stringify(wrapper)};
    import { add, then, default as defaultMethod } from ${JSON.stringify(wrapper)};
    export const equal = api === ns && add === ns.add;
    export const hidden = api.then === undefined && ns.then === undefined;
    export const result = then(7);
    export const defaultResult = defaultMethod(9);
  `)
  assert.equal(module.equal, true)
  assert.equal(module.hidden, true)
  assert.deepEqual(module.result, { name: 'then', args: [7] })
  assert.deepEqual(module.defaultResult, { name: 'default', args: [9] })
  const defaultImport = await rewriteRpcImports(`import api from './compute.rpc'`, 'main.ts', isRpc)
  assert.match(defaultImport!.code, /import \{ __workerRpcNamespace as api \} from/)
})

test('rewrites standalone namespace imports to the shared non-thenable facade', async () => {
  const module = await execute(`
    import * as first from ${JSON.stringify(wrapper)};
    import * as second from ${JSON.stringify(wrapper)};
    export const equal = first === second && first.add === second.add;
    export const hidden = first.then === undefined;
    export const result = first.add(1, 2);
  `)
  assert.equal(module.equal, true)
  assert.equal(module.hidden, true)
  assert.deepEqual(module.result, { name: 'add', args: [1, 2] })
})

test('allows Promise.resolve and async return of static namespace and default API imports', { timeout: 2_000 }, async () => {
  const module = await execute(`
    import * as namespace from ${JSON.stringify(wrapper)};
    import api from ${JSON.stringify(wrapper)};
    async function getNamespace() { return namespace; }
    async function getApi() { return api; }
    export const namespaceEqual = (await getNamespace()) === namespace;
    export const apiEqual = (await getApi()) === api;
    export const promiseEqual = (await Promise.resolve(namespace)) === api;
  `)
  assert.equal(module.namespaceEqual, true)
  assert.equal(module.apiEqual, true)
  assert.equal(module.promiseEqual, true)
})

test('hoists named property bindings and avoids identifiers in nested scopes', async () => {
  const source = `
    export const result = add(1, 2);
    import { add } from ${JSON.stringify(wrapper)};
    function unused(__worker_rpc_0) { return __worker_rpc_0; }
  `
  const transformed = await rewriteRpcImports(source, 'main.js', async value => value === wrapper)
  assert.ok(transformed)
  assert.match(transformed.code, /import __worker_rpc_1 from/)
  const module = await import(dataUrl(transformed.code))
  assert.deepEqual(module.result, { name: 'add', args: [1, 2] })
})

test('preserves interpreter and directive prologues before generated bindings', async () => {
  const source = '#!/usr/bin/env node\n"use client";\nimport { add } from "./compute.rpc";\nadd(1, 2);'
  const transformed = await rewriteRpcImports(source, 'main.js', isRpc)
  assert.ok(transformed)
  const ast = parse(transformed.code, { sourceType: 'module' })
  assert.equal(ast.program.interpreter?.value, '/usr/bin/env node')
  assert.deepEqual(ast.program.directives.map(directive => directive.value.value), ['use client'])
  assert.match(transformed.code, /^#!\/usr\/bin\/env node\n"use client";/)
})

test('supports named re-exports and namespace re-exports', async () => {
  const module = await execute(`
    export { add as sum, then as runThen } from ${JSON.stringify(wrapper)};
    export * as compute from ${JSON.stringify(wrapper)};
  `)
  assert.equal(module.sum, module.compute.add)
  assert.equal(module.compute.then, undefined)
  assert.equal(await Promise.resolve(module.compute), module.compute)
  assert.deepEqual(module.sum(1, 2), { name: 'add', args: [1, 2] })
  assert.deepEqual(module.runThen(5), { name: 'then', args: [5] })
})

test('rejects runtime export-star from RPC but leaves non-RPC export-star intact', async () => {
  await assert.rejects(
    rewriteRpcImports(`export * from './compute.rpc'`, 'barrel.ts', isRpc),
    /barrel\.ts: export \*.*explicit named re-exports or export \* as name/,
  )
  assert.equal(await rewriteRpcImports(`export * from './ordinary'`, 'barrel.ts', isRpc), null)
})

test('rewrites literal dynamic imports without assimilating the RPC then method', async () => {
  const module = await execute(`
    const first = await import(${JSON.stringify(wrapper)});
    const second = await import(${JSON.stringify(wrapper)}).then(module => module);
    export const equal = first === second;
    export const result = first.add(1, 2);
    export const then = undefined;
    export const hidden = first.then === undefined;
  `)
  assert.equal(module.equal, true)
  assert.equal(module.hidden, true)
  assert.deepEqual(module.result, { name: 'add', args: [1, 2] })
})

test('handles literal template imports and preserves dynamic import options and precedence', async () => {
  const transformed = await rewriteRpcImports(`
    const result = (await import(\`./compute.rpc?pool=auto\`)).add;
    const later = import('./compute.rpc', { with: { type: 'javascript' } });
    const variable = import(path);
    const template = import(\`./\${name}.rpc\`);
  `, 'main.ts', isRpc)
  assert.ok(transformed)
  parse(transformed.code, { sourceType: 'module', plugins: ['typescript'] })
  assert.equal(transformed.code.match(/\.__workerRpcNamespace/g)?.length, 2)
  assert.match(transformed.code, /with: \{ type: 'javascript' \}/)
  assert.match(transformed.code, /import\(path\)/)
  assert.match(transformed.code, /import\(`\.\/\$\{name\}\.rpc`\)/)
})

test('resolves duplicate static/dynamic source requests only once', async () => {
  const resolutions: string[] = []
  await rewriteRpcImports(`
    import { add } from '@compute';
    export { subtract } from '@compute';
    const promise = import('@compute');
  `, 'main.ts', async source => { resolutions.push(source); return true })
  assert.deepEqual(resolutions, ['@compute'])
})

test('parses consumer TSX and JSX without treating RPC source types as inputs', async () => {
  for (const id of ['view.tsx', 'view.jsx']) {
    const transformed = await rewriteRpcImports(`
      import { calculate } from './compute.rpc';
      export const View = () => <button onClick={() => calculate(1)}>Run</button>;
    `, id, isRpc)
    assert.ok(transformed)
    assert.match(transformed.code, /const calculate =/)
  }
})
