import { add as single } from './compute.rpc?pool=1'
import { add as bounded } from './compute.rpc?pool=4'
import { add as automatic } from './compute.rpc?pool=auto'
import { add as unlimited, greet } from './compute.rpc?pool=unlimited'
import {
  applyCallback,
  applyOptionalCallback,
  applyNullableCallback,
  applyCallbackOrValue,
  useNestedCallback,
  readProxiedObject,
  createCounter,
  createMultiplier,
  cloneData,
  collect,
} from './compute.rpc?pool=auto'
import { proxy, releaseProxy, transfer } from '../../../src/client.js'
import { createEndpoint } from 'comlink'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

type SingleParameters = Expect<Equal<Parameters<typeof single>, [a: number, b: number]>>
type SingleResult = Expect<Equal<ReturnType<typeof single>, Promise<number>>>
type BoundedResult = Expect<Equal<ReturnType<typeof bounded>, Promise<number>>>
type AutoResult = Expect<Equal<ReturnType<typeof automatic>, Promise<number>>>
type UnlimitedResult = Expect<Equal<ReturnType<typeof unlimited>, Promise<number>>>
type AsyncResult = Expect<Equal<ReturnType<typeof greet>, Promise<string>>>
type OptionalAndRest = Expect<Equal<Parameters<typeof collect>, [first: number, label?: string, ...values: number[]]>>

const result: number = await automatic(1, 2)
const pending: Promise<number> = bounded(1, 2)
const greeting: string = await greet('Ada')
void [result, pending, greeting]

// @ts-expect-error Argument types must survive the query import.
single('1', 2)
// @ts-expect-error All required parameters must survive the query import.
bounded(1)
// @ts-expect-error A sync implementation still has an async browser proxy.
const syncResult: number = automatic(1, 2)
// @ts-expect-error Unlimited mode retains concrete parameter types.
unlimited(1, false)
// @ts-expect-error Original async return types must also remain concrete.
const incorrectGreeting: Promise<number> = greet('Ada')
// @ts-expect-error Query declarations must not invent exported functions.
import { absent } from './compute.rpc?pool=auto'

const callbackResult: number = await applyCallback(proxy((value: number) => value * 2), 3)
const asyncCallbackResult: number = await applyCallback(proxy(async (value: number) => value * 2), 3)
const automaticCallbackResult: number = await applyCallback((value) => {
  type InferredCallbackValue = Expect<Equal<typeof value, number>>
  return value * 2
}, 3)
const automaticAsyncCallbackResult: number = await applyCallback(async (value) => {
  type InferredAsyncCallbackValue = Expect<Equal<typeof value, number>>
  return value * 2
}, 3)
await applyOptionalCallback(3)
await applyOptionalCallback(3, undefined)
await applyOptionalCallback(3, (value) => {
  type InferredOptionalCallbackValue = Expect<Equal<typeof value, number>>
  return value * 2
})
await applyNullableCallback(3, null)
await applyNullableCallback(3, async (value) => value * 2)
await applyCallbackOrValue(3)
await applyCallbackOrValue((value) => {
  type InferredUnionCallbackValue = Expect<Equal<typeof value, number>>
  return value * 2
})
const localObject = proxy({
  value: 1,
  increment(amount: number) {
    this.value += amount
    return this.value
  },
})
const objectResult: number = await readProxiedObject(localObject)
void [callbackResult, asyncCallbackResult, automaticCallbackResult, automaticAsyncCallbackResult, objectResult]

// @ts-expect-error Proxied callback parameters retain their original types.
applyCallback(proxy((value: string) => value.length), 3)
// @ts-expect-error Proxied callback results retain their original types.
applyCallback(proxy((value: number) => String(value)), 3)
// @ts-expect-error Automatic callback parameters retain their original types.
applyCallback((value: string) => value.length, 3)
// @ts-expect-error Automatic callback results retain their original types.
applyCallback((value: number) => String(value), 3)
// @ts-expect-error Automatic async callback results retain their original types.
applyCallback(async (value: number) => String(value), 3)
// @ts-expect-error Optional callbacks must retain their result types.
applyOptionalCallback(3, (value) => String(value))
// @ts-expect-error Nullable callbacks must retain their argument types.
applyNullableCallback(3, (value: string) => value.length)
// @ts-expect-error Callback unions must retain their result types.
applyCallbackOrValue(async (value) => String(value))
// @ts-expect-error Proxied object methods retain their original parameter types.
readProxiedObject(proxy({ value: 1, increment(amount: string) { return amount.length } }))
// @ts-expect-error Objects are not implicitly proxied, even if they have methods.
readProxiedObject({ value: 1, increment(amount: number) { return amount } })
// @ts-expect-error Nested callbacks are not implicitly proxied.
useNestedCallback({ callback: (value: number) => value * 2 })

const counter = await createCounter(1)
type RemoteProperty = Expect<Equal<typeof counter.value, Promise<number>>>
type RemoteMethodResult = Expect<Equal<ReturnType<typeof counter.increment>, Promise<number>>>
const count: number = await counter.value
const incremented: number = await counter.increment(2)
counter[releaseProxy]()
void [count, incremented]

const multiplier = await createMultiplier(3)
type RemoteFunctionResult = Expect<Equal<ReturnType<typeof multiplier>, Promise<number>>>
const multiplied: number = await multiplier(4)
multiplier[releaseProxy]()
void multiplied

// @ts-expect-error Returned remote properties need to be awaited.
const synchronousProperty: number = counter.value
// @ts-expect-error Returned proxy methods preserve their argument types.
counter.increment('2')
// @ts-expect-error Returned proxy functions preserve their argument types.
multiplier('4')
// @ts-expect-error Module exports are plain pool wrappers, not Comlink proxies.
automatic[releaseProxy]()
// @ts-expect-error Pool wrappers do not expose Comlink endpoint creation.
createCounter[createEndpoint]()

const bytes = new Uint8Array([1, 2, 3])
const data = await cloneData(transfer({ count: 1, bytes, dates: new Map([['today', new Date()]]) }, [bytes.buffer]))
type ClonedProperty = Expect<Equal<typeof data.count, number>>
type ClonedBytes = Expect<Equal<typeof data.bytes, Uint8Array>>
type ClonedMap = Expect<Equal<typeof data.dates, Map<string, Date>>>
// @ts-expect-error A cloned object is not a remote proxy.
data[releaseProxy]()
