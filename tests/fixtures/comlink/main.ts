import { proxy, releaseProxy, transfer, transferHandlers } from 'vite-plugin-worker-rpc/client'
import { CustomValue, sharedHandlers } from './value'
import {
  callbackValue, transferBuffer, transferredLength, copyBuffer, returnFunction,
  roundTripCustom, then as callThen, bind as callBind,
} from './compute.rpc?pool=2'

Object.assign(globalThis, {
  comlinkApi: {
    async callbacks() {
      const synchronous = await callbackValue(proxy((value: number) => value + 1), 4)
      const asynchronous = await callbackValue(proxy(async (value: number) => value + 2), 4)
      const errors = []
      for (const callback of [
        proxy(() => { throw new TypeError('synchronous callback error') }),
        proxy(async () => { throw new TypeError('asynchronous callback error') }),
      ]) {
        try { await callbackValue(callback, 0) } catch (error) { errors.push({ name: error.name, message: error.message }) }
      }
      return { synchronous, asynchronous, errors }
    },
    async sharedCallback() {
      const calls: { value: number; workerId: string }[] = []
      let release!: () => void
      const barrier = new Promise<void>((resolve) => { release = resolve })
      const callback = proxy(async (value: number, workerId: string) => {
        calls.push({ value, workerId })
        if (calls.length === 4) release()
        await barrier
        return value * 3
      })
      const results = await Promise.all([1, 2, 3, 4].map((value) => callbackValue(callback, value)))
      // Releasing each received remote reference must not poison the original
      // main-thread function, or its independently serialized references.
      const reused = await callbackValue(callback, 10)
      return { calls, results, reused }
    },
    async buffers() {
      const moved = new Uint8Array([7, 8, 9]).buffer
      const received = await transferBuffer(transfer(moved, [moved]))
      const senderLength = moved.byteLength
      const workerLength = await transferredLength()
      const copied = new Uint8Array([20, 21]).buffer
      const copy = await copyBuffer(copied)
      return {
        senderLength, workerLength, received: Array.from(new Uint8Array(received)),
        copied: Array.from(new Uint8Array(copied)), copy: Array.from(new Uint8Array(copy)),
      }
    },
    async returnedFunction() {
      const remote = await returnFunction(40)
      const value = await remote(2)
      remote[releaseProxy]()
      let released = false
      try { await remote(3) } catch (error) { released = /released/.test(error.message) }
      return { value, released }
    },
    async customHandler() {
      const value = await roundTripCustom(new CustomValue(6))
      return {
        helpersShareRegistry: transferHandlers === sharedHandlers,
        isCustomValue: value instanceof CustomValue,
        value: value.value,
        doubled: value.double(),
      }
    },
    async specialExports() { return [await callThen(1), await callBind(2)] },
  },
})
