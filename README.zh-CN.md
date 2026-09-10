# vite-plugin-worker-rpc

像调用普通函数一样，让计算在 Web Worker 中执行。

[English](./README.md)

```ts
import { add } from './compute.rpc'

const result = await add(1, 2)
```

这个 Vite 插件把 `*.rpc.ts` / `*.rpc.js` 的具名函数导出转换为异步 Worker 调用，自动生成 Worker 入口和浏览器端代理，无需另行配置运行时库。

## 安装

目前尚未发布到 npm，可以直接从公开的 GitHub 仓库安装：

```sh
npm install -D git+https://github.com/fenghengzhi/vite-plugin-worker-rpc.git
```

Git 依赖通过 `prepare` 脚本构建。需要 Node.js `^20.19.0 || >=22.12.0`，支持 Vite 6.4、7、8。

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

第一次调用时才会创建 Worker。默认情况下，同一个模块的所有导出共享一个 Worker 和模块状态。仅导入模块不会创建 Worker。`async` 函数内部的同步计算仍然在 Worker 线程执行。

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

TypeScript 中带 query 的导入需要显式模块声明，详见 [TypeScript 类型](#typescript-类型)。

| 导入方式 | 池内 Worker 数量上限 |
| --- | --- |
| `./compute.rpc` 或 `./compute.rpc?pool=1` | 一个共享 Worker，两种导入使用同一个池。 |
| `./compute.rpc?pool=N` | 大于 `0` 的安全整数 `N`。 |
| `./compute.rpc?pool=auto` | `Math.max(1, navigator.hardwareConcurrency - 1)`；硬件值缺失或不是大于 `0` 的安全整数时回退为 `4`。 |
| `./compute.rpc?pool=unlimited` | 不设固定上限。 |

所有池都按需增长：调用优先复用空闲 Worker；全部忙碌且尚未达到上限时，才创建新 Worker。达到上限后，调用会立即发给实际未完成请求最少的 Worker，不在主线程排队。同一个 Worker 中的 CPU 密集型计算仍在同一线程运行；异步调用可以在该 Worker 中交错执行。

`auto` 在池首次被调用时读取硬件值，之后固定这个上限，没有额外的固定最大值。`unlimited` 同样会复用空闲 Worker；池忙碌时可以持续增长，已创建的 Worker 会保留到池被释放或页面重新加载，不会在空闲时自动缩减。

池的身份由解析后的源模块和规范化后的池模式共同决定。不同文件中的导入、路径别名，只要解析到相同源模块和相同模式，就共享一个池。无 query 的导入与 `pool=1` 共用一个池。其他模式彼此独立：即使 `auto` 算出的上限恰好等于某个显式数值，两者也不会合并。上限作用于每个模块的每种模式，不是整个应用的全局 CPU 预算。

每个 Worker 都有独立的模块状态。池内的调用可能被分发到不同 Worker，因此不能假设模块级计数器、缓存或可变变量在全部调用间共享。超时会拒绝调用者的 Promise，但不会停止请求，也不会在实际响应到达前把对应 Worker 当作空闲。

数值必须是没有前导零的十进制数字，范围为 `1` 到 `Number.MAX_SAFE_INTEGER`。`0`、`01`、负数、小数、重复的 `pool` 参数和不支持的 query 参数都会报错。Vite 的 `?raw`、`?url`、`?worker` 导入保留原有含义，不能与 `pool` 混用。

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

`Remote<T>` 将函数返回值映射为 Promise，仅用于类型标注，不会再包一层运行时代理。参数和返回值仍然必须支持结构化克隆。

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

支持本地声明的具名函数、值为函数的变量、这些函数的导出别名，以及纯类型声明：

```ts
export interface Input { value: number }

export async function double(input: Input) {
  return input.value * 2
}

const triple = async (value: number) => value * 3
export { triple as multiplyByThree }
```

默认导出、导出的运行时值或类、生成器函数、运行时重新导出和 `export *` 会触发构建错误。需要导出外部函数时，用本地函数包装；共享常量放到普通模块。可以保留未导出的模块状态。

实现及其导入依赖都在 Worker 中执行。一个 RPC 实现通过本地依赖引用另一个 RPC 模块时，即使路径包含 `?pool=...`，后者也会作为当前 Worker 的普通本地依赖执行，不会产生嵌套 Worker 池或 RPC 调用。依赖必须兼容 Worker 环境：没有 `window` 和 DOM，也不能使用仅适用于 Node.js 的 API。模块在每个 Worker 启动时分别初始化一次，而不是在主线程导入代理时初始化。

## 配置

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `include` | `**/*.rpc.{ts,js,mts,mjs}` | 需要转换的模块。 |
| `exclude` | `**/node_modules/**` | 不进行转换的模块。 |
| `timeoutMs` | `30000` | 单次调用的超时毫秒数，`0` 表示禁用。 |

`include` / `exclude` 使用 `@rollup/pluginutils` 的匹配规则，接受 glob 字符串、正则表达式，或两者组成的数组。相对 glob 以 Vite 项目根目录为基准。传入值会替换对应的默认值。`timeoutMs` 必须是 `0` 到 `2147483647` 之间的整数。

```ts
workerRpc({
  include: 'src/computation/**/*.rpc.ts',
  exclude: ['**/node_modules/**', '**/*.test.rpc.ts'],
  timeoutMs: 60_000,
})
```

## 运行行为与限制

- 调用始终返回 Promise，并发请求分别匹配自己的结果，完成顺序可能与调用顺序不同。池的调度不保证连续调用会进入同一个 Worker。
- 参数和结果通过 `postMessage` 结构化克隆传递。没有 transfer list 或回调代理 API，函数和 DOM 节点不能直接跨越这个边界。
- 远程异常会让 Promise 拒绝，错误对象保留名称、消息，以及可用时的堆栈，不保留自定义属性和原型。
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

测试覆盖导出校验、RPC 传输，以及真实 Chromium Worker 中的 Vite 开发和生产流程，包括非根路径部署和开发刷新。CI 使用 Node.js 22，分别测试 Vite 6、7、8。

## 协议

MIT
