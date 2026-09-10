import { add as single } from './compute.rpc?pool=1'
import { add as bounded } from './compute.rpc?pool=4'
import { add as automatic } from './compute.rpc?pool=auto'
import { add as unlimited, greet } from './compute.rpc?pool=unlimited'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

type SingleParameters = Expect<Equal<Parameters<typeof single>, [a: number, b: number]>>
type SingleResult = Expect<Equal<ReturnType<typeof single>, Promise<number>>>
type BoundedResult = Expect<Equal<ReturnType<typeof bounded>, Promise<number>>>
type AutoResult = Expect<Equal<ReturnType<typeof automatic>, Promise<number>>>
type UnlimitedResult = Expect<Equal<ReturnType<typeof unlimited>, Promise<number>>>
type AsyncResult = Expect<Equal<ReturnType<typeof greet>, Promise<string>>>

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
