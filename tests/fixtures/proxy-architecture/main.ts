import {
  calculate as namedCalculate, imported, reexported, nested,
  notCallable, NotCallableClass, absent, then as callThen, bind as callBind,
} from './compute.rpc'
import * as calculations from './compute.rpc?pool=1'
import defaultApi from './compute.rpc?pool=1'
import { calculate as aliasCalculate } from '@rpc?pool=1'
import { reexportedCalculate, calculations as barrelNamespace } from './barrel'
import { fromOtherConsumer } from './consumer'
import { fromFramework } from './component.vue'

Object.assign(globalThis, {
  architectureApi: {
    async namespaces() {
      const resolved = await Promise.all([calculations, defaultApi, barrelNamespace])
      const returned = await (async () => calculations)()
      return resolved.every(api => api === calculations) && returned === calculations && calculations.then === undefined
    },
    async run() {
      const dynamic = await import('./compute.rpc?pool=1')
      const callbacks = [namedCalculate, calculations.calculate, aliasCalculate, reexportedCalculate, barrelNamespace.calculate, dynamic.calculate]
      const results = await Promise.all(callbacks.map((calculate, index) => calculate(index + 1, (n: number) => n * 2)))
      const otherConsumer = await fromOtherConsumer(7)
      const framework = await fromFramework(41)
      const inlineHtml = await globalThis.inlineHtmlCalculate(42, (n: number) => n + 1)
      const failure = await namedCalculate(1, () => { throw new TypeError('callback failed') }).catch(error => ({ name: error.name, message: error.message }))
      const bindingResults = await Promise.all([imported(1), reexported(2), nested(3)])
      const methodErrors = []
      for (const method of [notCallable, NotCallableClass, absent]) {
        try { await method() } catch (error) { methodErrors.push({ name: error.name, message: error.message }) }
      }
      return {
        results, otherConsumer, framework, inlineHtml, failure, bindingResults, methodErrors,
        sharedInlineMethod: globalThis.inlineHtmlCalculate === namedCalculate,
        specialExports: [await callThen(1), await callBind(2), await calculations.bind(3), await dynamic.bind(4)],
        stableMethods: calculations.calculate === calculations.calculate,
        sharedMethods: callbacks.every(method => method === namedCalculate),
      }
    },
  },
})
