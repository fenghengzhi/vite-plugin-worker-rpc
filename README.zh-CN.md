# vite-plugin-worker-rpc

像调用普通函数一样，让计算在 Web Worker 中执行。

[English](./README.md)

```ts
import { add } from './compute.rpc'

const result = await add(1, 2)
```

这个 Vite 插件把 `*.rpc.ts` / `*.rpc.js` 的具名函数导出转换为异步 Worker 调用，自动生成 Worker 入口和浏览器端代理。[Comlink](https://github.com/GoogleChromeLabs/comlink) 负责 RPC 消息、序列化和远程引用，插件负责 Vite 集成与 Worker 池。Comlink 已作为依赖包含在包中，无需额外配置。

## 安装

```sh
npm install -D vite-plugin-worker-rpc
```

需要 Node.js `^20.19.0 || >=22.12.0`，支持 Vite 6.4、7、8。

也可以通过 `npm install -D git+https://github.com/fenghengzhi/vite-plugin-worker-rpc.git` 直接从 GitHub 安装，Git 依赖会通过 `prepare` 脚本构建。

## 使用

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'

export default defineConfig({
  plugins: [workerRpc()],
})
```

```ts
// src/compute.rpc.ts：实现在 Worker 中执行
export async function add(a: number, b: number): Promise<number> {
  return a + b
}
```

```ts
// src/main.ts：浏览器主线程
import { add } from './compute.rpc'

console.log(await add(1, 2)) // 3
```

第一次调用时才会创建 Worker。默认配置下，同一个模块的所有导出共享一个自动决定上限的 Worker 池，每个 Worker 拥有独立的模块状态。仅导入模块不会创建 Worker。`async` 函数内部的同步计算仍然在 Worker 线程执行。如果调用必须共享一个 Worker 和模块状态，请使用 `?pool=1`，也可以通过 `workerRpc({ pool: 1 })` 设置项目默认值。

## Worker 池

通过导入路径上的 `pool` 参数选择 Worker 池：

```js
import { add } from './compute.rpc?pool=4'

const results = await Promise.all([
  add(1, 2),
  add(3, 4),
  add(5, 6),
])
```

在 Vite 插件配置中设置 `pool`，即可指定项目默认值。优先级为 **import query > 插件配置 > `'auto'`**。无 query 的导入使用配置中的模式，显式 query 会覆盖它。完整的 Vite 配置示例见[配置](#配置)。

TypeScript 中带 query 的导入需要显式模块声明，详见 [TypeScript 类型](#typescript-类型)。

| 导入方式 | 池内 Worker 数量上限 |
| --- | --- |
| `./compute.rpc` | 使用插件的 `pool` 配置；未配置时为 `'auto'`。 |
| `./compute.rpc?pool=auto` | `Math.max(1, navigator.hardwareConcurrency - 1)`；硬件值缺失或不是大于 `0` 的安全整数时回退为 `4`。 |
| `./compute.rpc?pool=1` | 一个共享 Worker。 |
| `./compute.rpc?pool=N` | 大于 `0` 的安全整数 `N`。 |
| `./compute.rpc?pool=unlimited` | 不设固定上限。 |

所有池都按需增长：调用优先复用空闲 Worker；全部忙碌且尚未达到上限时，才创建新 Worker。达到上限后，调用会立即发给实际未完成请求最少的 Worker，不在主线程排队。同一个 Worker 中的 CPU 密集型计算仍在同一线程运行；异步调用可以在该 Worker 中交错执行。

`auto` 在池首次被调用时读取硬件值，之后固定这个上限，没有额外的固定最大值。`unlimited` 同样会复用空闲 Worker；池忙碌时可以持续增长，已创建的 Worker 会保留到池被释放或页面重新加载，不会在空闲时自动缩减。

池的身份由解析后的源模块和最终池模式共同决定。不同文件中的导入、路径别名，只要解析到相同源模块和相同模式，就共享一个池。配置 `workerRpc({ pool: 2 })` 后，`./compute.rpc` 与 `./compute.rpc?pool=2` 共用一个池，`./compute.rpc?pool=auto` 则使用独立的池，即使 `auto` 算出的上限恰好也是 `2`。未配置默认值时，无 query 的导入与 `pool=auto` 共用一个池。每个源模块都有自己的池；项目配置设置的是它们的默认模式，不会创建整个应用共用的全局池，也不是全局 CPU 预算。

每个 Worker 都有独立的模块状态。池内的调用可能被分发到不同 Worker，因此不能假设模块级计数器、缓存或可变变量在全部调用间共享。超时会拒绝调用者的 Promise，但不会停止请求，也不会在实际响应到达前把对应 Worker 当作空闲。

query 中的数值必须是没有前导零的十进制数字，范围为 `1` 到 `Number.MAX_SAFE_INTEGER`。query 中的 `0`、`01`、负数、小数、重复的 `pool` 参数和不支持的 query 参数都会报错。Vite 的 `?raw`、`?url`、`?worker` 导入保留原有含义，不能与 `pool` 混用。

## 文件后缀的选择

默认匹配 `**/*.rpc.{ts,js,mts,mjs}`。`.rpc` 表达的是异步调用边界，但没有说明传输方式：其他工具也可能用 `.rpc.ts` 表示服务端 API。这里由插件名称和 Vite 配置约定它指向浏览器 Worker。

如果项目中的 RPC 只有这一种含义，简短的 `.rpc.ts` 约定很方便。如果项目同时存在服务端 RPC，建议限制目录，或使用更明确的 `.worker-rpc.ts`：

```ts
workerRpc({
  include: '**/*.worker-rpc.{ts,js,mts,mjs}',
})
```

`include` 会替换默认匹配规则。插件不会默认接管所有 `.worker.ts`：普通的 Vite Worker 入口也可能使用这个后缀，但并不提供 RPC API。把文件改为符合匹配规则的名称，会改变它的执行位置，并使浏览器中的调用变成异步。

## TypeScript 类型

**建议把 TypeScript RPC 导出写成 `async` 函数。** Vite 改写的是运行时代码，不会同步改写 TypeScript 对源文件的类型认知。同步的 `add(): number` 可以运行，但其浏览器代理实际返回 `Promise<number>`，编辑器仍会显示 `number`。

对于已有的同步模块，可以显式声明远程命名空间类型：

```ts
import * as implementation from './compute.rpc'
import type { Remote } from 'vite-plugin-worker-rpc'

const api = implementation as unknown as Remote<typeof implementation>
const result = await api.add(1, 2)
```

`Remote<T>` 使用 Comlink 的参数与结果映射描述生成模块的导出函数，直接回调参数可以传普通函数，也兼容显式用 `proxy()` 标记的值。它仅用于类型标注，不会再包一层运行时代理。带回调参数或返回代理的 API 也应使用它：仅写 `async` 无法描述这些值跨线程后的类型变化。其他未标记的参数和结果必须支持结构化克隆。

### 带 query 的导入声明

TypeScript 不会自动把任意 query 导入解析为源模块的类型，即使源文件已经导出 `async` 函数。需要为每种实际使用的 query 写法和导出函数添加显式声明：

```ts
// src/worker-rpc.d.ts：与 src/compute.rpc.ts 放在同一目录
// 此文件不要包含顶层 import/export 语句。
declare module '*compute.rpc?pool=4' {
  type API = import('vite-plugin-worker-rpc').Remote<typeof import('./compute.rpc')>
  export const add: API['add']
}
```

```ts
// src/main.ts
import { add } from './compute.rpc?pool=4'

const result: number = await add(1, 2)
// add('1', 2) 会产生类型错误。
```

确保 `tsconfig.json` 包含这个 `.d.ts` 文件。其中 `typeof import('./compute.rpc')` 的路径相对于声明文件。使用 `?pool=auto`、`?pool=unlimited` 或其他数值时，分别添加对应的模块声明，并按相同方式列出导出函数。显式带 `.ts` 扩展名的导入也需要匹配其写法的声明。

通配后缀必须在整个 TypeScript 项目中唯一对应**一个源模块**。如果多个目录都有 `compute.rpc.ts`，请使用唯一的 RPC 文件名，或改用 `*math/compute.rpc?pool=4` 这样带有区分路径的规则，并确保导入路径包含该后缀。宽泛的通配声明无法自动推导每个匹配文件的导出。上述显式声明保留实际参数和结果类型，不会退化成 `any`；插件目前不会自动生成这些声明。

## 导出与执行规则

RPC 实现使用普通 ESM 导出。函数可以在本地声明、赋给变量、导入后再导出，或直接从其他模块重新导出，也支持纯类型声明：

```ts
export interface Input { value: number }

export async function double(input: Input) {
  return input.value * 2
}

const triple = async (value: number) => value * 3
export { triple as multiplyByThree }

export { add } from './math'
export * from './more-functions'
```

插件不在构建时枚举或校验实现模块的导出，而是在调用到达 Worker 后按名称查找。调用不存在的导出或非函数导出时，Promise 会以 `TypeError` 拒绝。类不能按普通函数调用，生成器的返回值不支持结构化克隆。导出的常量保留在 Worker 中，浏览器代理不提供这些值；两端都需要的常量请放到普通共享模块。

### 导入方式与生成模块

继续使用具名导入、导入别名或命名空间导入：

```ts
import { add as sum } from './compute.rpc'
import * as compute from './compute.rpc'

await sum(1, 2)
await compute.add(1, 2)
```

插件生成一个带动态 `Proxy` 的浏览器模块，以及一个导入原始实现的 Worker 入口。连同原始实现，共三个逻辑模块；最终输出文件数由 Vite 的打包决定。浏览器模块还提供一个固定的内部导出，供动态导入使用，不会为每个 RPC 函数逐一生成导出，也不会修改实现中的函数体。

另一个转换步骤把调用方的导入改写为浏览器代理的属性访问。它读取调用方请求的名称，不扫描 RPC 实现的导出列表。代理在访问时生成对应方法，并通过 Worker 池发送调用。直接传入的函数参数会分别自动代理，整个参数数组不会变成远程引用。

应用模块可以使用具名重新导出和命名空间重新导出：

```ts
// src/api.ts
export { add, multiplyByThree as triple } from './compute.rpc'
export * as compute from './compute.rpc'
```

调用方的 `export * from './compute.rpc'` 需要枚举 RPC 导出，因此会被拒绝；请列出具体名称，或改用 `export * as compute`。这一限制不影响原始 Worker 实现内部的重新导出，例如上面的 `export * from './more-functions'`。

调用方的具名导入和重新导出会把缓存的代理方法绑定到本地变量，并非指向 Worker 导出的原生实时绑定。如果调用方通过导入或重新导出形成循环依赖，在模块初始化期间提前调用，可能因这些变量尚未初始化而触发暂时性死区错误。请打破循环，或把调用推迟到模块初始化完成后。原始 Worker 实现内部的依赖仍遵循普通 ESM 语义。

也支持路径为字面量的动态导入：

```ts
const compute = await import('./compute.rpc')
await compute.add(1, 2)
```

请使用字面量路径，不支持路径依赖运行时变量的动态导入。静态或动态导入得到的命名空间/API 对象都会隐藏 `then`，避免 Promise 解析过程误调用 RPC 导出；调用名为 `then` 的函数时，请使用 `import { then as runThen } from './compute.rpc'` 这样的具名导入。命名空间代理提供方法访问，不提供导出发现功能：不要用 `Object.keys`、`for...in` 或 `in` 枚举或判断可用导出。纯类型导入保持为类型用途，不会启动 Worker。

实现及其导入依赖都在 Worker 中执行。一个 RPC 实现通过本地依赖引用另一个 RPC 模块时，即使路径包含 `?pool=...`，后者也会作为当前 Worker 的普通本地依赖执行，不会产生嵌套 Worker 池或 RPC 调用。依赖必须兼容 Worker 环境：没有 `window` 和 DOM，也不能使用仅适用于 Node.js 的 API。模块在每个 Worker 启动时分别初始化一次，而不是在主线程导入代理时初始化。

## 回调、数据转移与远程对象

适用于浏览器的 `vite-plugin-worker-rpc/client` 入口导出了 Comlink 的 `proxy`、`transfer`、`releaseProxy` 和 `transferHandlers`。主线程和 Worker 都使用这个入口，确保辅助函数与传输层在各自线程中使用同一个 Comlink 实例；混用另一份 Comlink 安装可能产生不同的 Symbol 和 handler 注册表。

### 回调参数

直接传入回调即可，插件会自动代理函数参数。回调仍在创建它的线程执行，Worker 通过异步调用访问它，可以等待其返回值或捕获其异常。同步和异步回调都支持。

```ts
// src/compute.rpc.ts
import type { RemoteProxy } from 'vite-plugin-worker-rpc/client'

export async function calculate(value: number, callback: RemoteProxy<(n: number) => number>) {
  return await callback(value)
}
```

```ts
// src/main.ts
import * as implementation from './compute.rpc'
import type { Remote } from 'vite-plugin-worker-rpc'
const api = implementation as unknown as Remote<typeof implementation>
const result = await api.calculate(21, n => n * 2) // 42；n 自动推断为 number。
```

`RemoteProxy<T>` 描述接收方得到的异步 Comlink 引用，`Remote<T>` 将这个参数映射为发送方的普通回调。自动包装不会修改原始函数，也支持冻结的回调。显式 `proxy(fn)` 仍然可用，已由自定义 transfer handler 处理的函数保留该 handler 的行为。

自动包装仅作用于生成的 RPC 导出函数的直接参数。对象或数组内部的函数、返回的函数，以及调用返回的 Comlink 引用的方法时传入的参数，仍需显式处理。自动回调只暴露函数调用行为；需要访问函数附加属性时，请使用显式代理。如果回调需要特定的 `this`，请先绑定方法再传入。

在现代浏览器中，收到的回调不再被引用后，Comlink 可以通过 `FinalizationRegistry` 自动回收。上面的例子可以依赖这一机制，但回收并不立即发生。插件不会在 RPC 调用结束时主动释放回调，因此 Worker 也可以有意保存回调供后续使用。如果需要及时清理，请在 Worker 中导入 `releaseProxy`，并在最后一次使用完成后释放收到的引用：

```ts
try {
  return await callback(value)
} finally {
  callback[releaseProxy]()
}
```

如果多个操作共享同一个收到的引用，需要等它们全部完成后再释放。同一个原始回调被多次传入 RPC 时，每次传输都会创建独立的 Comlink 端点，各接收方释放自己的引用不会使其他次传输失效。

### 转移所有权，避免复制

普通 `ArrayBuffer` 参数会被克隆。`transfer(value, transferables)` 把所列资源的所有权移交给接收线程；对于 `ArrayBuffer`，消息发送时原线程的 buffer 会被分离（detached）。两个方向都支持转移：

```ts
// src/buffers.rpc.ts
import { transfer } from 'vite-plugin-worker-rpc/client'

export async function increment(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! + 1
  return transfer(buffer, [buffer]) // 把所有权转回主线程。
}
```

```ts
// src/main.ts
import { increment } from './buffers.rpc'
import { transfer } from 'vite-plugin-worker-rpc/client'

const buffer = new Uint8Array([1, 2, 3]).buffer
const result = await increment(transfer(buffer, [buffer]))
console.log(buffer.byteLength) // 0：原 buffer 已被分离。
console.log([...new Uint8Array(result)]) // [2, 3, 4]
```

同一个已经转移的 buffer 不能再次作为并发调用的输入；请使用独立 buffer，或省略 `transfer()` 改用克隆。应对直接参数或直接返回值调用 `transfer()`，transfer list 可以列出包含在这个值内部的 buffer。

### 返回远程对象或函数

RPC 导出可以返回 `proxy(object)` 或 `proxy(function)`，把原值保留在它所属的 Worker。`proxy()` 的返回类型带有 Comlink 的代理标记，`Remote<T>` 会据此描述浏览器收到的异步引用：

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

请保留 `proxy()` 推导出的返回类型，或在显式类型中保留代理标记；把它标注为没有标记的普通对象或函数，会丢失远程类型映射。通过返回引用进行的后续调用固定进入创建它的 Worker，直接使用 Comlink，不参与插件的池调度、负载统计或 `timeoutMs` 超时控制。

### 自定义序列化与引用生命周期

Comlink 的 `transferHandlers` 可以支持额外的值类型。每个 handler 必须在**调用前，以同一个名称注册到两端**。例如，将注册代码放在普通共享模块中，从 `vite-plugin-worker-rpc/client` 导入 `transferHandlers`，再由主线程入口和 RPC 实现分别导入这个模块。`canHandle`、`serialize` 和 `deserialize` 的约定见 [Comlink transfer handler 文档](https://github.com/GoogleChromeLabs/comlink#transfer-handlers-and-event-listeners)。

Comlink 处理直接参数与直接返回值，不会递归地对嵌套属性应用这些辅助函数或 handler。例如，`{ callback: fn }` 和 `{ callback: proxy(fn) }` 都不会自动成为受支持的回调参数；请把 `fn` 作为独立参数传入，代理整个外层对象，或为外层值提供 handler。DOM 节点，以及不在直接参数自动处理范围内的未标记函数，不支持结构化克隆。

应用需要管理收到的回调引用和返回对象引用的生命周期。现代浏览器支持 Comlink 自动回收不可达的代理；需要及时清理时，在最后一次使用后显式释放，包括出错路径。停止池会清理池内 Worker 及池自身的传输资源，不保证自动清理应用代码持有的所有回调通道或返回代理。超时不会释放这些引用，也不会取消计算。

## 配置

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `include` | `**/*.rpc.{ts,js,mts,mjs}` | 需要转换的模块。 |
| `exclude` | `**/node_modules/**` | 不进行转换的模块。 |
| `pool` | `'auto'` | 无 query 导入的默认池模式：大于 `0` 的安全整数、`'auto'` 或 `'unlimited'`。 |
| `timeoutMs` | `0` | 单次调用的超时毫秒数，`0` 表示禁用。 |

`include` / `exclude` 使用 `@rollup/pluginutils` 的匹配规则，接受 glob 字符串、正则表达式，或两者组成的数组。相对 glob 以 Vite 项目根目录为基准。传入值会替换对应的默认值。数值型 `pool` 配置应使用 `4` 这样的 number，不能使用字符串 `'4'`。`timeoutMs` 必须是 `0` 到 `2147483647` 之间的整数。

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'

export default defineConfig({
  plugins: [
    workerRpc({
      include: 'src/computation/**/*.rpc.ts',
      exclude: ['**/node_modules/**', '**/*.test.rpc.ts'],
      pool: 4, // 每个模块默认使用最多四个 Worker 的池。
      timeoutMs: 60_000, // 可选：启用 60 秒超时。
    }),
  ],
})
```

**迁移到 0.3.1：** 调用默认不再超时。设置 `timeoutMs: 30_000` 可保留之前的 30 秒超时。默认池模式仍为 `'auto'`；如果希望无 query 的导入使用单 Worker，可以设置 `pool: 1`，每个模块各自拥有一个 Worker。

**迁移到 0.4.0：** RPC 改由 Comlink 提供。错误处理也采用 Comlink 的语义：支持结构化克隆的非 `Error` 抛出值保留原值；无法序列化的返回值以 `TypeError: Unserializable return value` 拒绝。回调和显式数据转移使用上文的 client 辅助函数。

## 运行行为与限制

- 调用始终返回 Promise，并发请求分别匹配自己的结果，完成顺序可能与调用顺序不同。池的调度不保证连续调用会进入同一个 Worker。
- 直接传入的函数参数会自动代理，其他参数和结果默认由 Comlink 进行结构化克隆。显式数据转移、远程对象、返回的函数或自定义 handler 使用上文的 client 辅助函数。
- Comlink 负责传递远程异常。抛出的 `Error` 保留名称、消息，以及可用时的堆栈，不保留自定义属性和原型。支持结构化克隆的非 `Error` 抛出值仍然保持为非 `Error` 值。
- 超时会拒绝调用者的 Promise，**不会取消计算**，实际响应到达前该请求仍计入未完成请求数。致命的 Worker 传输故障会停止整个池、拒绝池内所有待处理调用，并使其代理在页面重新加载前无法继续使用。导出函数抛出的异常只会拒绝对应调用。
- SSR 阶段可以导入 RPC 模块；在没有浏览器 Worker 支持的环境中调用会拒绝，没有服务端执行回退。
- 开发时修改已追踪的 Worker 源文件会触发整页刷新。Worker 状态会重置，未完成调用随旧页面一起被丢弃。
- 当前面向浏览器专用 Worker，不提供 SharedWorker、取消、流式返回，也不会在生成的模块代理上提供生命周期方法或自动改写 TypeScript 返回类型。

## 运行示例

```sh
git clone https://github.com/fenghengzhi/vite-plugin-worker-rpc.git
cd vite-plugin-worker-rpc
npm install
npm run dev
```

示例在 Worker 中重复求和，同时展示主线程动画和画面更新计数。

```sh
npx playwright install chromium
npm run check
npm run build:playground
```

测试覆盖导入改写、运行时导出分发、RPC 传输，以及真实 Chromium Worker 中的 Vite 开发和生产流程，包括非根路径部署和开发刷新。CI 使用 Node.js 22，分别测试 Vite 6、7、8。

## 发布版本

[发布工作流](./.github/workflows/publish.yml)会先运行 Vite 6/7/8 测试矩阵，再进行发布。工作流在 GitHub 托管的 Ubuntu 上使用 Node.js 24 和 npm 12.0.2，通过 GitHub OIDC 使用 npm Trusted Publishing，并生成 provenance。无需配置 `NPM_TOKEN` 仓库密钥。

### 一次性 npm 配置

包需要先在 npm 上存在。维护者需先在仓库中使用已登录的 npm 账号手动发布初始 `0.2.0`，完成 2FA 验证，再配置可信发布者。这些步骤是自动发布的前置条件。

```sh
# 仅首次发布，在完成构建和测试后执行。
npm publish --access public

# 使用 npm 12.0.2 配置该包信任的 GitHub 工作流。
npm trust github vite-plugin-worker-rpc \
  --repo fenghengzhi/vite-plugin-worker-rpc \
  --file publish.yml \
  --allow-publish --yes
```

也可以在 npm 包设置中配置 Trusted Publisher：GitHub owner 填 `fenghengzhi`，repository 填 `vite-plugin-worker-rpc`，workflow filename 填 `publish.yml`，environment name 留空，并开启直接发布。

### 发布新版本

在工作区干净的 `main` 分支中递增版本，推送生成的提交和附注标签：

```sh
npm version patch # 次版本发布使用 minor
git push origin main --follow-tags
```

推送 `v*` 标签会触发工作流。实际发布要求当前 Git ref 是标签，名称严格等于 `v` 加上 `package.json` 中的版本号，例如 `v0.2.0`。正式版本使用 `latest`，预发布版本使用 `next`；如果版本已经发布，则跳过发布。

如果只想验证工作流，在 GitHub Actions 页面手动运行 `publish.yml`，选择 `main` 并保持 `dry_run` 开启（默认值）。这会运行测试和打包校验；版本尚未发布时，还会执行 `npm publish --dry-run`，已有版本则跳过此命令，因为 npm 会拒绝对已有版本进行发布演练。整个过程不会发布 npm 包，也不能据此确认实际发布权限。手动正式发布时，选择与版本匹配的标签并关闭 `dry_run`。

## 协议

MIT
