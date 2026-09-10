import { proxy, releaseProxy, transfer, transferHandlers } from 'vite-plugin-worker-rpc/client'
import { CustomValue, sharedHandlers } from './value'
import {
  callbackValue, transferBuffer, transferredLength, copyBuffer, returnFunction,
  retainCallback, nestedCallbackValue, roundTripCustom, customFunctionValue, then as callThen, bind as callBind,
} from './compute.rpc?pool=2'

Object.assign(globalThis, {
  comlinkApi: {
    async callbacks() {
      const synchronous = await callbackValue((value: number) => value + 1, 4)
      const asynchronous = await callbackValue(async (value: number) => value + 2, 4)
      const explicit = await callbackValue(proxy((value: number) => value + 3), 4)
      const errors = []
      for (const callback of [
        () => { throw new TypeError('synchronous callback error') },
        async () => { throw new TypeError('asynchronous callback error') },
      ]) {
        try { await callbackValue(callback, 0) } catch (error) { errors.push({ name: error.name, message: error.message }) }
      }
      return { synchronous, asynchronous, explicit, errors }
    },
    async sharedCallback() {
      const calls: { value: number; workerId: string }[] = []
      let release!: () => void
      const barrier = new Promise<void>((resolve) => { release = resolve })
      const callback = async (value: number, workerId: string) => {
        calls.push({ value, workerId })
        if (calls.length === 4) release()
        await barrier
        return value * 3
      }
      const originalKeys = Reflect.ownKeys(callback)
      const results = await Promise.all([1, 2, 3, 4].map((value) => callbackValue(callback, value)))
      // Releasing each received remote reference must not poison the original
      // main-thread function, or its independently serialized references.
      const reused = await callbackValue(callback, 10)
      return { calls, results, reused, originalUnchanged: originalKeys.length === Reflect.ownKeys(callback).length }
    },
    async frozenCallback() {
      const callback = Object.freeze((value: number) => value * 2)
      const originalKeys = Reflect.ownKeys(callback)
      const result = await callbackValue(callback, 21)
      return {
        value: result.value,
        released: result.released,
        originalUnchanged: originalKeys.length === Reflect.ownKeys(callback).length,
        originalValue: callback(4),
      }
    },
    async retainedCallback() {
      const values: number[] = []
      const remote = await retainCallback((value: number) => {
        values.push(value)
        return value * 2
      })
      // The first RPC has completed. Its callback remains usable until the
      // Worker releases it, even though its original call has left the pool.
      try {
        const first = await remote.call(21)
        const second = await remote.call(22)
        return { values, first, second }
      } finally {
        await remote.dispose()
        remote[releaseProxy]()
      }
    },
    async nestedCallback() {
      try {
        await nestedCallbackValue({ callback: (value: number) => value * 2 }, 21)
      } catch (error) {
        return { name: error.name }
      }
      throw new Error('Nested callbacks unexpectedly received automatic proxy conversion')
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
      const customFunction = Object.assign(() => {
        throw new Error('Custom function handler must replace this source function')
      }, { multiplier: 3 })
      const functionValue = await customFunctionValue(customFunction, 7)
      return {
        helpersShareRegistry: transferHandlers === sharedHandlers,
        isCustomValue: value instanceof CustomValue,
        value: value.value,
        doubled: value.double(),
        functionValue,
      }
    },
    async specialExports() { return [await callThen(1), await callBind(2)] },
  },
})
