import { isBuiltin } from 'node:module'
import { parse } from 'acorn'

type Node = { type: string; [key: string]: unknown }
const isNode = (value: unknown): value is Node => Boolean(value && typeof value === 'object' && 'type' in value)
function names(pattern: unknown): string[] {
  if (!isNode(pattern)) return []
  if (pattern.type === 'Identifier') return [String(pattern.name)]
  return Object.values(pattern).flatMap((value) =>
    Array.isArray(value) ? value.flatMap(names) : isNode(value) ? names(value) : [],
  )
}

export function validateBrowserModule(source: string) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Node
  const body = ast.body as Node[]
  if (!body.some((node) => node.type.startsWith('Export'))) throw new Error('插件 UI 入口必须导出浏览器 ESM 模块')
  const visit = (node: Node, scopes: Set<string>[]) => {
    let current = scopes
    if (
      node.type === 'Program' ||
      node.type === 'BlockStatement' ||
      node.type.includes('Function') ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const bindings = new Set<string>()
      for (const param of (node.params as unknown[] | undefined) ?? [])
        for (const name of names(param)) bindings.add(name)
      for (const statement of (Array.isArray(node.body) ? node.body : []) as Node[]) {
        if (statement.type === 'VariableDeclaration') {
          for (const declaration of statement.declarations as Node[])
            for (const name of names(declaration.id)) bindings.add(name)
        }
        if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
          for (const name of names(statement.id)) bindings.add(name)
        }
      }
      current = [...scopes, bindings]
    }
    const bound = (name: string) => current.some((scope) => scope.has(name))
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ImportExpression'
    ) {
      const specifier = node.source as Node | undefined
      if (
        specifier &&
        typeof specifier.value === 'string' &&
        (isBuiltin(specifier.value) || specifier.value.startsWith('node:') || specifier.value === 'electron')
      )
        throw new Error(`插件 UI 不能导入 Node 模块：${specifier.value}`)
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as Node
      if (
        (callee.type === 'Identifier' && callee.name === 'require' && !bound('require')) ||
        (callee.type === 'MemberExpression' &&
          (callee.object as Node).type === 'Identifier' &&
          (callee.object as Node).name === 'require' &&
          !bound('require'))
      )
        throw new Error('插件 UI 含未打包的 Node require 调用')
    }
    if (
      node.type === 'MemberExpression' &&
      (node.object as Node).type === 'Identifier' &&
      (node.object as Node).name === 'module' &&
      !bound('module')
    )
      throw new Error('插件 UI 含顶层 CommonJS module 引用')
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child, current)
      } else if (isNode(value)) visit(value, current)
    }
  }
  visit(ast, [])
}
