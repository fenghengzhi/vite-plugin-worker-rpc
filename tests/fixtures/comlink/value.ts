import { transferHandlers } from 'vite-plugin-worker-rpc/client'

export class CustomValue {
  constructor(public value: number) {}
  double() { return this.value * 2 }
}

// Register through the public helper module on both sides. The transport must
// use this same registry for the class prototype to survive the round trip.
transferHandlers.set('worker-rpc-test-custom-value', {
  canHandle: (value): value is CustomValue => value instanceof CustomValue,
  serialize: (value: CustomValue) => [value.value, []],
  deserialize: (value: number) => new CustomValue(value),
})

// A registered function handler takes precedence over automatic callbacks.
type CustomFunction = ((value: number) => number) & { multiplier: number }
transferHandlers.set('worker-rpc-test-custom-function', {
  canHandle: (value): value is CustomFunction => typeof value === 'function' && typeof (value as CustomFunction).multiplier === 'number',
  serialize: (value: CustomFunction) => [value.multiplier, []],
  deserialize: (multiplier: number) => Object.assign((value: number) => value * multiplier, { multiplier }),
})

export { transferHandlers as sharedHandlers }
