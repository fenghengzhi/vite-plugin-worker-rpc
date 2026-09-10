import { parse } from '@babel/parser'
import MagicString from 'magic-string'

/** Rewrite the consuming module, without reading or enumerating RPC exports. */
export async function rewriteRpcImports(
  code: string,
  id: string,
  resolveRpc: (source: string) => Promise<boolean>,
): Promise<{ code: string; map: ReturnType<MagicString['generateMap']> } | null> {
  if (!/\b(?:import|export)\b/.test(code)) return null
  const filename = id.split('?', 1)[0]!
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: id,
    createImportExpressions: true,
    plugins: [
      ...(/\.[cm]?tsx?$/.test(filename) ? ['typescript' as const] : []),
      ...(/\.[jt]sx$/.test(filename) ? ['jsx' as const] : []),
      'importAttributes',
      'decorators-legacy',
    ],
  })
  const identifiers = new Set<string>()
  const dynamicImports: any[] = []
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Identifier') identifiers.add(node.name)
    if (node.type === 'ImportExpression') dynamicImports.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key.endsWith('Comments') || key === 'comments') continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object' && 'type' in value) visit(value)
    }
  }
  visit(ast.program)
  let sequence = 0
  function uniqueName(): string {
    let name: string
    do { name = `__worker_rpc_${sequence++}` } while (identifiers.has(name))
    identifiers.add(name)
    return name
  }
  const resolution = new Map<string, Promise<boolean>>()
  function isRpc(source: string): Promise<boolean> {
    let result = resolution.get(source)
    if (!result) {
      result = resolveRpc(source)
      resolution.set(source, result)
    }
    return result
  }
  function stringValue(node: any): string | undefined {
    if (node?.type === 'StringLiteral') return node.value
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return node.quasis[0].value.cooked ?? undefined
    }
  }
  function name(node: any): string {
    return node.type === 'Identifier' ? node.name : node.value
  }
  function printedName(node: any): string {
    return node.type === 'Identifier' ? node.name : JSON.stringify(node.value)
  }
  const result = new MagicString(code)
  const bindings: string[] = []
  let changed = false
  function replaceStatement(statement: any, replacement: string): void {
    // Keep comments from the declaration when replacing its specifier list.
    // Specifiers themselves are printed from the AST to avoid copying comments twice.
    const comments = (ast.comments ?? [])
      .filter(comment => comment.start! >= statement.start && comment.end! <= statement.end)
      .map(comment => code.slice(comment.start!, comment.end!))
    result.overwrite(statement.start, statement.end, [...comments, replacement].join('\n'))
    changed = true
  }
  function importDeclaration(binding: string, source: string, statement: any): string {
    // Preserve import attributes where present; comments are copied separately.
    const attributes = statement.attributes?.length
      ? ` with { ${statement.attributes.map((attribute: any) =>
        `${printedName(attribute.key)}: ${JSON.stringify(attribute.value.value)}`).join(', ')} }`
      : ''
    return `import ${binding} from ${source}${attributes};`
  }

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (statement.importKind === 'type' || statement.specifiers.length === 0) continue
      const runtime = statement.specifiers.filter(specifier =>
        specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type')
      if (runtime.length === 0) continue
      if (!await isRpc(statement.source.value)) continue
      const source = code.slice(statement.source.start!, statement.source.end!)
      const existingDefault = runtime.find(specifier => specifier.type === 'ImportDefaultSpecifier')
      const namespace = runtime.find(specifier => specifier.type === 'ImportNamespaceSpecifier')
      const named = runtime.filter(specifier => specifier.type === 'ImportSpecifier')
      const proxy = named.length ? uniqueName() : undefined
      const facade = existingDefault?.local.name ?? namespace?.local.name
      const imported = [proxy, facade ? `{ __workerRpcNamespace as ${facade} }` : undefined]
        .filter(Boolean).join(', ')
      const lines = [importDeclaration(imported, source, statement)]
      if (namespace && namespace.local.name !== facade) {
        bindings.push(`const ${namespace.local.name} = ${facade};`)
      }
      for (const specifier of runtime) {
        if (specifier.type === 'ImportSpecifier') {
          bindings.push(`const ${specifier.local.name} = ${proxy}[${JSON.stringify(name(specifier.imported))}];`)
        }
      }
      const types = statement.specifiers.filter(specifier =>
        specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
      if (types.length) {
        lines.push(`import { ${types.map((specifier: any) =>
          `type ${printedName(specifier.imported)} as ${specifier.local.name}`).join(', ')} } from ${source};`)
      }
      replaceStatement(statement, lines.join('\n'))
      continue
    }
    if (statement.type === 'ExportAllDeclaration') {
      if (statement.exportKind === 'type' || !await isRpc(statement.source.value)) continue
      throw new Error(`[vite-plugin-worker-rpc] ${id}: export * from an RPC module is not supported without enumerating its exports. Use explicit named re-exports or export * as name instead.`)
    }
    if (statement.type !== 'ExportNamedDeclaration' || !statement.source || statement.exportKind === 'type') continue
    const runtime = statement.specifiers.filter(specifier =>
      specifier.type !== 'ExportSpecifier' || specifier.exportKind !== 'type')
    if (runtime.length === 0 || !await isRpc(statement.source.value)) continue
    const source = code.slice(statement.source.start!, statement.source.end!)
    const proxy = runtime.some(specifier => specifier.type === 'ExportSpecifier') ? uniqueName() : undefined
    const facade = runtime.some(specifier => specifier.type === 'ExportNamespaceSpecifier') ? uniqueName() : undefined
    const imported = [proxy, facade ? `{ __workerRpcNamespace as ${facade} }` : undefined]
      .filter(Boolean).join(', ')
    const lines = [importDeclaration(imported, source, statement)]
    for (const specifier of runtime) {
      const exported = printedName(specifier.exported)
      if (specifier.type === 'ExportNamespaceSpecifier') {
        lines.push(`export { ${facade} as ${exported} };`)
      } else if (specifier.type === 'ExportSpecifier') {
        const local = uniqueName()
        bindings.push(`const ${local} = ${proxy}[${JSON.stringify(name(specifier.local))}];`)
        lines.push(`export { ${local} as ${exported} };`)
      } else {
        throw new Error(`[vite-plugin-worker-rpc] ${id}: unsupported RPC re-export. Use an explicit named re-export.`)
      }
    }
    const types = statement.specifiers.filter(specifier =>
      specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type')
    if (types.length) {
      lines.push(`export { ${types.map((specifier: any) =>
        `type ${printedName(specifier.local)} as ${printedName(specifier.exported)}`).join(', ')} } from ${source};`)
    }
    replaceStatement(statement, lines.join('\n'))
  }
  for (const expression of dynamicImports) {
    const source = stringValue(expression.source)
    if (source === undefined || !await isRpc(source)) continue
    const namespace = uniqueName()
    // Parentheses retain precedence for await, chained calls and property access.
    // The exported namespace masks `then` so Promise resolution cannot call an RPC export.
    result.prependLeft(expression.start, '(')
    result.appendLeft(expression.end, `.then(${namespace} => ${namespace}.__workerRpcNamespace))`)
    changed = true
  }
  if (!changed) return null
  if (bindings.length) {
    const directives = ast.program.directives
    const insertion = directives.length ? directives[directives.length - 1]!.end! : ast.program.interpreter?.end ?? 0
    // Imports are hoisted in ESM. Hoist property bindings too, so a source file
    // may use an imported function before its textual import declaration.
    result.prependLeft(insertion, `\n${bindings.join('\n')}\n`)
  }
  return { code: result.toString(), map: result.generateMap({ source: id, includeContent: true, hires: true }) }
}
