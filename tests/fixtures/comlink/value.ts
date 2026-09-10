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

export { transferHandlers as sharedHandlers }
