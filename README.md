# vite-plugin-worker-rpc

Import a function. Run it in a Web Worker.

[简体中文](./README.zh-CN.md)

```ts
import { add } from './compute.rpc'

const result = await add(1, 2)
```

A Vite plugin that turns named function exports from `*.rpc.ts` and `*.rpc.js` into asynchronous Worker calls. It generates the Worker entry and browser proxy, with no runtime library to configure.

## Install

The package is not published to npm yet. Install the public GitHub repository:

```sh
npm install -D git+https://github.com/fenghengzhi/vite-plugin-worker-rpc.git
```

The Git dependency builds through its `prepare` script. Requires Node.js `^20.19.0 || >=22.12.0` and Vite 6.4, 7, or 8.

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

The first call starts a Worker. All exports from the same module share that Worker and its module state; different RPC modules get separate Workers. Importing alone does not start one. Synchronous computation inside an `async` export still runs on the Worker thread.

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

`Remote<T>` maps function return types to Promises. It is a type helper, not an additional runtime wrapper. Arguments and results must still be structured-cloneable.

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

Implementation imports execute in the Worker. A local RPC module reached from another RPC implementation is a normal local dependency of that Worker; it does not create a nested RPC call. Dependencies must support the Worker environment: there is no `window` or DOM, and Node-only APIs are unavailable. Module initialization runs when the Worker starts, not when the browser imports the proxy.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `include` | `**/*.rpc.{ts,js,mts,mjs}` | Files transformed into RPC modules. |
| `exclude` | `**/node_modules/**` | Files left unchanged. |
| `timeoutMs` | `30000` | Per-call timeout in milliseconds; `0` disables it. |

`include` and `exclude` accept a glob string, regular expression, or array of either, using `@rollup/pluginutils` filtering. Relative globs resolve from Vite's project root. Supplied values replace their respective defaults. `timeoutMs` must be an integer from `0` to `2147483647`.

```ts
workerRpc({
  include: 'src/computation/**/*.rpc.ts',
  exclude: ['**/node_modules/**', '**/*.test.rpc.ts'],
  timeoutMs: 60_000,
})
```

## Runtime behavior and limits

- Calls always return Promises. Concurrent requests are matched to their own results. CPU-bound calls in one Worker execute on the same thread; multiple calls do not create a Worker pool.
- Arguments and results use `postMessage` structured cloning. There are no transfer-list or callback-proxy APIs; functions and DOM nodes cannot cross the boundary.
- Remote exceptions reject with an `Error` carrying its name, message, and stack when available. Custom error properties and prototypes are not preserved.
- A timeout rejects the caller's Promise; it does **not** cancel the computation. Worker failures reject pending calls and make that proxy unusable until the page is reloaded.
- RPC modules may be imported during SSR. Calling their proxies without browser Worker support rejects; there is no server-side fallback.
- Changes to tracked Worker sources trigger a full page reload during development. Worker state is reset, and pending calls are discarded with the old page.
- This version targets browser dedicated Workers. It does not provide SharedWorker support, cancellation, streaming, a public Worker lifecycle API, or automatic TypeScript return-type rewriting.

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

## License

MIT
