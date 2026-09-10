import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

test('explicit query declarations preserve function parameters, export names and Promise results', () => {
  const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/types/${name}`, import.meta.url))
  const program = ts.createProgram([fixture('main.ts'), fixture('worker-rpc.d.ts')], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    // Do not hide errors in the ambient declarations under test.
    skipLibCheck: false,
    types: ['node'],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const formatted = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
  assert.equal(diagnostics.length, 0, formatted)
})
