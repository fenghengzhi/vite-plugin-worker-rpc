import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectRpcExports } from '../src/exports.js'

test('collects functions, arrows, aliases and ignores type exports', () => {
  assert.deepEqual(collectRpcExports(`
    export type Input = number
    export interface Shape { value: number }
    export function add(a: number, b: number): number { return a + b }
    export const multiply = (a: number, b: number) => a * b
    const subtract = function(a: number, b: number) { return a - b }
    export { subtract as minus }
    export type { Something } from './types'
  `, 'compute.rpc.ts'), ['add', 'multiply', 'minus'])
})

test('supports async functions, satisfies and overloads', () => {
  assert.deepEqual(collectRpcExports(`
    export function add(a: number): number;
    export function add(a: number) { return a + 1 }
    export const asyncAdd = (async (a: number) => a + 1) satisfies (a: number) => Promise<number>
  `, 'compute.rpc.ts'), ['add', 'asyncAdd'])
})

for (const source of [
  'export default function add() {}',
  'export const value = 1',
  'export class Example {}',
  'export enum Example { A }',
  'export * from "./other"',
  'export { add } from "./other"',
  'export function* sequence() { yield 1 }',
  'export const { add } = api',
  'import { add } from "./other"; export { add }',
]) {
  test(`rejects unsupported export: ${source}`, () => {
    assert.throws(() => collectRpcExports(source, 'compute.rpc.ts'), /vite-plugin-worker-rpc/)
  })
}
