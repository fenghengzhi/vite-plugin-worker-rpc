import { parse } from '@babel/parser'

/** Collect deliberately supported RPC exports without evaluating user code. */
export function collectRpcExports(code: string, filename: string): string[] {
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: filename,
    plugins: /\.[cm]?tsx?$/.test(filename) ? ['typescript'] : [],
  })
  const functions = new Set<string>()
  const fail = (message: string): never => {
    throw new Error(`[vite-plugin-worker-rpc] ${filename}: ${message}`)
  }
  function callable(node: any): boolean {
    if (!node) return false
    if (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) {
      return callable(node.expression)
    }
    return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type) && !node.generator
  }
  function remember(node: any): void {
    if (node?.type === 'FunctionDeclaration' && !node.declare && !node.generator && node.id) {
      functions.add(node.id.name)
    }
    if (node?.type === 'VariableDeclaration' && !node.declare) {
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier' && callable(declaration.init)) {
          functions.add(declaration.id.name)
        }
      }
    }
  }
  for (const statement of ast.program.body) {
    remember(statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement)
  }
  const names = new Set<string>()
  function add(local: string, exported = local): void {
    if (exported === 'default') fail('Default exports are not supported. Use named functions.')
    if (!functions.has(local)) {
      fail(`Export "${exported}" must be a locally declared function or function-valued variable. Put constants and shared types in a separate module.`)
    }
    names.add(exported)
  }
  for (const statement of ast.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') fail('Default exports are not supported. Use named functions.')
    if (statement.type === 'ExportAllDeclaration') {
      if (statement.exportKind !== 'type') fail('export * is not supported. Export locally declared named functions.')
      continue
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue
    const declaration = statement.declaration
    if (declaration) {
      if (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration' ||
          declaration.type === 'TSDeclareFunction' || ('declare' in declaration && declaration.declare)) continue
      if (declaration.type === 'FunctionDeclaration' && declaration.id) {
        add(declaration.id.name)
      } else if (declaration.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) {
          if (item.id.type !== 'Identifier') fail('Destructured exports are not supported.')
          else add(item.id.name)
        }
      } else {
        fail('Only named functions and type-only declarations may be exported from RPC modules.')
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type') continue
      if (statement.source) fail('Re-exports are not supported. Wrap imported functions in a local exported function.')
      if (specifier.type !== 'ExportSpecifier') fail('Only named function exports are supported.')
      else add(specifier.local.name, specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value)
    }
  }
  return [...names]
}
