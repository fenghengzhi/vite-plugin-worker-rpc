# vite-plugin-worker-rpc

Import a function. Run it in a Web Worker.

[简体中文](./README.zh-CN.md)

```ts
import { add } from './compute.rpc'

const result = await add(1, 2)
```

A Vite plugin that turns named function exports from `*.rpc.ts` and `*.rpc.js` into asynchronous Worker calls. It generates the Worker entry and browser proxy. [Comlink](https://github.com/GoogleChromeLabs/comlink) handles RPC messages, serialization, and remote references; the plugin handles Vite integration and Worker pools. Comlink is included as a dependency and needs no separate setup.

## Install

```sh
npm install -D vite-plugin-worker-rpc
```

Requires Node.js `^20.19.0 || >=22.12.0` and Vite 6.4, 7, or 8.

To install directly from GitHub, use `npm install -D git+https://github.com/fenghengzhi/vite-plugin-worker-rpc.git`; the Git dependency builds through its `prepare` script.

## Use

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'

export default defineConfig({
  plugins: [workerRpc()],
})
```

```ts
// src/compute.rpc.ts — implementation runs in a Worker
export async function add(a: number, b: number): Promise<number> {
  return a + b
}
```

```ts
// src/main.ts — runs in the browser
import { add } from './compute.rpc'

console.log(await add(1, 2)) // 3
```

The first call starts a Worker. With the default configuration, all exports from the same module share an automatically sized Worker pool; each Worker has its own module state. Importing alone does not start one. Synchronous computation inside an `async` export still runs on the Worker thread. Use `?pool=1` when calls must share one Worker and its module state, or set the project's default with `workerRpc({ pool: 1 })`.

## Worker pools

Choose a pool for an import with the `pool` query parameter:

```js
import { add } from './compute.rpc?pool=4'

const results = await Promise.all([
  add(1, 2),
  add(3, 4),
  add(5, 6),
])
```

Set `pool` in the Vite plugin options to choose the project default. The precedence is **import query > plugin option > `'auto'`**. Imports without a query use the configured mode; an explicit query overrides it. See [Options](#options) for a complete Vite configuration.

TypeScript query imports need an explicit module declaration; see [TypeScript](#typescript).

| Import | Maximum Workers in the pool |
| --- | --- |
| `./compute.rpc` | The plugin's `pool` option, or `'auto'` when omitted. |
| `./compute.rpc?pool=auto` | `Math.max(1, navigator.hardwareConcurrency - 1)`; falls back to `4` if the hardware value is missing or is not a positive safe integer. |
| `./compute.rpc?pool=1` | One shared Worker. |
| `./compute.rpc?pool=N` | A positive safe integer `N`. |
| `./compute.rpc?pool=unlimited` | No fixed maximum. |

Pools grow lazily: each call first reuses an idle Worker, then creates a Worker if below the maximum. At the maximum, it immediately sends the call to the Worker with the fewest actual unfinished requests. There is no main-thread task queue. CPU-bound work on one Worker still runs on one thread; asynchronous calls may interleave within that Worker.

`auto` reads the hardware value on the pool's first call, then keeps that maximum. It has no additional fixed cap. `unlimited` reuses idle Workers too; a busy pool can grow without a fixed bound and retains its peak Worker count until disposal or a page reload.

Pool identity is the resolved source module plus its final pool mode. Imports from different files or through aliases share a pool when they resolve to the same source and mode. With `workerRpc({ pool: 2 })`, `./compute.rpc` and `./compute.rpc?pool=2` share a pool, while `./compute.rpc?pool=auto` has a separate pool, even when `auto` calculates a maximum of `2`. With no configured default, the unqueried import and `pool=auto` share a pool. Each source module has its own pools; the project option sets their default mode, not a global pool or CPU budget for the application.

Every Worker has its own module state. Calls may move between Workers in a pool, so do not rely on a module-level counter, cache, or mutable variable being shared across all calls. A timeout rejects the caller but does not stop the request or make its Worker idle before the actual response arrives.

Numeric query values must use decimal digits without leading zeros, from `1` to `Number.MAX_SAFE_INTEGER`. Invalid query values such as `0`, `01`, negative numbers, fractions, duplicate `pool` parameters, and unsupported query parameters produce errors. Vite's `?raw`, `?url`, and `?worker` imports retain their normal meanings; they cannot be combined with `pool`.

## Filename convention

The default pattern is `**/*.rpc.{ts,js,mts,mjs}`. `.rpc` describes the asynchronous call boundary, but does not identify its transport: other tools may use `.rpc.ts` for server APIs. The plugin name and Vite configuration establish that these files run in browser Workers.

Use the short convention when the project has one meaning for RPC. If your project also has server RPC modules, use a narrower directory or the more explicit `.worker-rpc.ts` suffix:

```ts
workerRpc({
  include: '**/*.worker-rpc.{ts,js,mts,mjs}',
})
```

`include` replaces the default pattern. The plugin intentionally does not claim every `.worker.ts` file: ordinary Vite Worker entry points may use that name without exposing an RPC API. Renaming a file into the configured pattern changes where it executes and makes its browser calls asynchronous.

## TypeScript

**Write TypeScript RPC exports as `async` functions.** Vite transforms runtime code, not TypeScript's view of the source module. A synchronous `add(): number` is callable at runtime, but its browser proxy returns `Promise<number>` while the editor still sees `number`.

For an existing synchronous module, you can explicitly describe the remote namespace:

```ts
import * as implementation from './compute.rpc'
import type { Remote } from 'vite-plugin-worker-rpc'

const api = implementation as unknown as Remote<typeof implementation>
const result = await api.add(1, 2)
```

`Remote<T>` describes the generated module's exported functions using Comlink's argument and result mappings, including values marked with `proxy()`. It is a type helper, not an additional runtime wrapper. Use it for APIs with callback parameters or returned proxies too: `async` alone does not describe how these values change across threads. Unmarked arguments and results must be structured-cloneable.

### Query import declarations

TypeScript does not automatically resolve an arbitrary query import to the source module's types, even when the source exports are `async`. Add an explicit declaration for each query spelling and exported function you use:

```ts
// src/worker-rpc.d.ts — next to src/compute.rpc.ts
// Keep this file free of top-level import/export statements.
declare module '*compute.rpc?pool=4' {
  type API = import('vite-plugin-worker-rpc').Remote<typeof import('./compute.rpc')>
  export const add: API['add']
}
```

```ts
// src/main.ts
import { add } from './compute.rpc?pool=4'

const result: number = await add(1, 2)
// add('1', 2) would be a type error.
```

Include the `.d.ts` file in your `tsconfig.json`. Its `typeof import('./compute.rpc')` path is relative to the declaration file. Add separate declarations for `?pool=auto`, `?pool=unlimited`, or other numbers you import, listing their exported functions in the same way. An import spelling with an explicit `.ts` extension also needs a matching declaration.

The wildcard suffix must identify **one source module** across your TypeScript project. If several directories contain `compute.rpc.ts`, use unique RPC filenames or a distinguishing pattern such as `*math/compute.rpc?pool=4` and import paths that include that suffix. A broad wildcard cannot automatically infer each matching file's exports. This explicit declaration preserves the original parameter and result types without falling back to `any`; the plugin does not generate these declarations for you.

## Exports and execution

Supported exports are locally declared named functions, function-valued variables, aliases of those functions, and type-only declarations:

```ts
export interface Input { value: number }

export async function double(input: Input) {
  return input.value * 2
}

const triple = async (value: number) => value * 3
export { triple as multiplyByThree }
```

Default exports, exported runtime values/classes, generator functions, runtime re-exports, and `export *` are rejected with build errors. Wrap imported functions in a local exported function, and keep shared constants in a regular module. Unexported module state is allowed.

Implementation imports execute in the Worker. A local RPC module reached from another RPC implementation is a normal local dependency of that Worker, even when its import includes `?pool=...`; it does not create a nested pool or RPC call. Dependencies must support the Worker environment: there is no `window` or DOM, and Node-only APIs are unavailable. Module initialization runs once in each Worker when it starts, not when the browser imports the proxy.

## Callbacks, transfers, and remote objects

The browser-safe `vite-plugin-worker-rpc/client` entry exports Comlink's `proxy`, `transfer`, `releaseProxy`, and `transferHandlers`. Use this entry in both browser and Worker code so the helpers and transport share the same Comlink instance within each thread; mixing another Comlink installation can create different symbols and handler registries.

### Callback parameters

Mark a callback with `proxy()`. It stays in the thread where it was created; the Worker calls it asynchronously and can await its return value or catch its exception.

```ts
// src/compute.rpc.ts
import { releaseProxy, type RemoteProxy } from 'vite-plugin-worker-rpc/client'

export async function calculate(value: number, callback: RemoteProxy<(n: number) => number>) {
  try {
    return await callback(value)
  } finally {
    callback[releaseProxy]() // This invocation has finished using this remote reference.
  }
}
```

```ts
// src/main.ts
import * as implementation from './compute.rpc'
import type { Remote } from 'vite-plugin-worker-rpc'
import { proxy } from 'vite-plugin-worker-rpc/client'

const api = implementation as unknown as Remote<typeof implementation>
const result = await api.calculate(21, proxy((n: number) => n * 2)) // 42
```

`RemoteProxy<T>` describes the receiver's asynchronous Comlink reference and preserves the proxy marker needed for parameter inference. `proxy()` marks the sender's original value; it does not turn that value into a remote reference locally. Call `[releaseProxy]()` on the received reference, after its last use. If several operations share a received reference, wait for all of them before releasing it. Sending the same original callback in multiple RPC calls creates an independent Comlink endpoint for each transmission, so each receiver releases its own reference without invalidating the other transmissions.

### Transfer ownership instead of copying

Ordinary `ArrayBuffer` values are cloned. `transfer(value, transferables)` moves the listed resources to the receiving thread. For an `ArrayBuffer`, this detaches the sender's buffer when the message is sent. Transfers work in both directions:

```ts
// src/buffers.rpc.ts
import { transfer } from 'vite-plugin-worker-rpc/client'

export async function increment(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! + 1
  return transfer(buffer, [buffer]) // Move ownership back to the browser.
}
```

```ts
// src/main.ts
import { increment } from './buffers.rpc'
import { transfer } from 'vite-plugin-worker-rpc/client'

const buffer = new Uint8Array([1, 2, 3]).buffer
const result = await increment(transfer(buffer, [buffer]))
console.log(buffer.byteLength) // 0: the original buffer was detached.
console.log([...new Uint8Array(result)]) // [2, 3, 4]
```

A transferred buffer cannot be reused as the input to concurrent calls; use separate buffers or omit `transfer()` to clone instead. Wrap the direct argument or direct return value with `transfer()`; its transfer list can include buffers contained in that value.

### Return a remote object or function

An RPC export can return `proxy(object)` or `proxy(function)` to keep that value in its Worker. The `proxy()` result carries Comlink's type marker, which `Remote<T>` uses to describe the browser's asynchronous reference:

```ts
// src/counter.rpc.ts
import { proxy } from 'vite-plugin-worker-rpc/client'

export async function createCounter() {
  let value = 0
  return proxy({ increment: () => ++value })
}
```

```ts
// src/main.ts
import * as implementation from './counter.rpc'
import type { Remote } from 'vite-plugin-worker-rpc'
import { releaseProxy } from 'vite-plugin-worker-rpc/client'

const api = implementation as unknown as Remote<typeof implementation>
const counter = await api.createCounter()
try {
  console.log(await counter.increment()) // 1
} finally {
  counter[releaseProxy]()
}
```

Keep the inferred `proxy()` return type, or explicitly preserve its proxy marker; annotating it as an ordinary unmarked object or function loses the remote type mapping. Calls through a returned reference stay attached to its owning Worker. They use Comlink directly and do not participate in the plugin's pool scheduling, load accounting, or `timeoutMs` deadline.

### Custom serialization and lifecycle

Comlink's `transferHandlers` can serialize additional value types. Register each handler under the **same name on both sides before the call**. For example, put the registration in a regular shared module, import `transferHandlers` from `vite-plugin-worker-rpc/client` there, and import that module from both the browser entry and the RPC implementation. See [Comlink's transfer handler API](https://github.com/GoogleChromeLabs/comlink#transfer-handlers-and-event-listeners) for the `canHandle`, `serialize`, and `deserialize` contract.

Comlink processes direct arguments and direct return values; it does not recursively apply these helpers or handlers to nested properties. For example, `{ callback: proxy(fn) }` is not automatically a supported callback parameter: pass `proxy(fn)` as its own argument, proxy the containing object, or provide a handler for the containing value. DOM nodes and unmarked functions are not structured-cloneable.

The application owns the lifetime of received callback and returned-object references. Release them after the last use, including error paths; garbage collection is not a deterministic cleanup mechanism. Stopping the pool cleans up the pool's Workers and its own transport resources. It does not guarantee cleanup of every callback channel or returned proxy held by application code. A timeout does not release those references or cancel computation.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `include` | `**/*.rpc.{ts,js,mts,mjs}` | Files transformed into RPC modules. |
| `exclude` | `**/node_modules/**` | Files left unchanged. |
| `pool` | `'auto'` | Default pool mode for imports without a query: a positive safe integer, `'auto'`, or `'unlimited'`. |
| `timeoutMs` | `0` | Per-call timeout in milliseconds; `0` disables it. |

`include` and `exclude` accept a glob string, regular expression, or array of either, using `@rollup/pluginutils` filtering. Relative globs resolve from Vite's project root. Supplied values replace their respective defaults. A numeric `pool` option must be a number, such as `4`, rather than the string `'4'`. `timeoutMs` must be an integer from `0` to `2147483647`.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'

export default defineConfig({
  plugins: [
    workerRpc({
      include: 'src/computation/**/*.rpc.ts',
      exclude: ['**/node_modules/**', '**/*.test.rpc.ts'],
      pool: 4, // Each module defaults to a pool of up to four Workers.
      timeoutMs: 60_000, // Optional: enable a 60-second timeout.
    }),
  ],
})
```

**Migrating to 0.3.1:** calls no longer time out by default. Set `timeoutMs: 30_000` to keep the previous 30-second timeout. The default pool mode remains `'auto'`; set `pool: 1` if unqueried imports should use one Worker per module.

**Migrating to 0.4.0:** RPC uses Comlink. Error handling follows Comlink too: structured-cloneable non-`Error` throws keep their original value, and an unserializable return value rejects with `TypeError: Unserializable return value`. Use the client helpers above for callbacks and explicit transfers.

## Runtime behavior and limits

- Calls always return Promises. Concurrent requests are matched to their own results; completion order can differ from call order. Pool scheduling does not guarantee that successive calls reach the same Worker.
- Comlink serializes arguments and results using structured cloning by default. Use the client helpers above for explicit transfers, callback proxies, remote objects, or custom handlers.
- Comlink transports remote exceptions. Thrown `Error` objects preserve their name, message, and stack when available, but not custom properties or prototypes. Structured-cloneable non-`Error` thrown values remain non-`Error` values.
- A timeout rejects the caller's Promise; it does **not** cancel the computation, which remains counted as unfinished until its response arrives. A fatal Worker transport failure stops the entire pool, rejects its pending calls, and makes its proxies unusable until the page is reloaded. An exception thrown by an exported function only rejects that call.
- RPC modules may be imported during SSR. Calling their proxies without browser Worker support rejects; there is no server-side fallback.
- Changes to tracked Worker sources trigger a full page reload during development. Worker state is reset, and pending calls are discarded with the old page.
- This version targets browser dedicated Workers. It does not provide SharedWorker support, cancellation, streaming, lifecycle methods on generated module proxies, or automatic TypeScript return-type rewriting.

## Try the playground

```sh
git clone https://github.com/fenghengzhi/vite-plugin-worker-rpc.git
cd vite-plugin-worker-rpc
npm install
npm run dev
```

The playground runs repeated summation in a Worker while displaying a live browser animation and frame counter.

```sh
npx playwright install chromium
npm run check
npm run build:playground
```

Tests cover export validation, RPC transport behavior, and actual Chromium Workers in Vite development and production, including a non-root base path and development reloads. CI runs against Vite 6, 7, and 8 on Node.js 22.

## Publishing releases

[The publish workflow](./.github/workflows/publish.yml) runs the Vite 6/7/8 test matrix before publishing. It uses npm Trusted Publishing through GitHub OIDC, with provenance, on GitHub-hosted Ubuntu with Node.js 24 and npm 12.0.2. No `NPM_TOKEN` repository secret is needed.

### One-time npm setup

The package must first exist on npm. A maintainer needs to publish the initial `0.2.0` from the repository with an authenticated npm account and complete its 2FA prompt, then configure the trusted publisher. This setup is a prerequisite for automatic releases.

```sh
# Initial publication only, after building and testing the release.
npm publish --access public

# With npm 12.0.2, configure the package's trusted GitHub workflow.
npm trust github vite-plugin-worker-rpc \
  --repo fenghengzhi/vite-plugin-worker-rpc \
  --file publish.yml \
  --allow-publish --yes
```

Alternatively, configure the package's Trusted Publisher in npm settings: GitHub owner `fenghengzhi`, repository `vite-plugin-worker-rpc`, workflow filename `publish.yml`, leave the environment name blank, and enable direct publishing.

### Release a version

From a clean `main` checkout, bump the version and push the generated commit and annotated tag:

```sh
npm version patch # use minor for a minor release
git push origin main --follow-tags
```

Pushing a `v*` tag triggers the workflow. A real publication requires the Git ref to be a tag matching `v` plus the version in `package.json`, such as `v0.2.0`. Stable versions publish under `latest`, prereleases under `next`; an already-published version is skipped.

To check the workflow without publishing, run `publish.yml` manually from the GitHub Actions page, choose `main`, and keep `dry_run` enabled (the default). This runs validation and tarball checks, plus `npm publish --dry-run` if the version is unpublished; npm rejects publication dry runs for existing versions. No package is published, and actual publishing authorization remains unverified. For a manual real release, select the matching version tag and disable `dry_run`.

## License

MIT
