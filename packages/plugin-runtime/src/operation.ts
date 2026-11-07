import { validateJsonSchema } from './schema'
import type { JsonSchema, JsonValue, PluginCallContext } from '@pi-meme/plugin-sdk/rpc'
import type { PluginOperation } from '@pi-meme/plugin-sdk/server'

export function checkedJson(value: unknown, limit = 4 * 1024 * 1024): JsonValue {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error('payload-too-large: JSON 嵌套过深')
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return
    if (Array.isArray(item)) {
      for (const v of item) visit(v, depth + 1)
      return
    }
    if (typeof item === 'object' && item && Object.getPrototypeOf(item) === Object.prototype) {
      for (const v of Object.values(item)) visit(v, depth + 1)
      return
    }
    throw new Error('invalid-input: 插件调用只能传递 JSON')
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new Error('payload-too-large: JSON 超过限制')
  return value as JsonValue
}
export function checkSchema(schema: JsonSchema, value: unknown, output = false) {
  checkedJson(value, output ? 4194304 : 1048576)
  checkedJson(schema, 262144)
  if (!validateJsonSchema(schema, value))
    throw new Error(`${output ? 'invalid-output' : 'invalid-input'}: 插件操作不符合 schema`)
}
export function authorizeOperation(operation: Omit<PluginOperation, 'execute'>, context: PluginCallContext) {
  if (!['read', 'workspace-write', 'external-write', 'full-access'].includes(operation.effect))
    throw new Error('permission-denied: 未知操作效果')
  if (!operation.audience.includes(context.origin)) throw new Error('audience-denied: 操作不接受此来源')
  if (context.mode === 'plan' && operation.effect !== 'read')
    throw new Error('permission-denied: Plan 只能执行只读操作')
  if (context.accessMode === 'read-only' && operation.effect !== 'read')
    throw new Error('permission-denied: 当前任务只读')
  if (operation.effect === 'workspace-write' && context.workspaceWritable !== true)
    throw new Error('permission-denied: 未授权工作区写入')
  if (operation.effect === 'full-access' && (context.accessMode !== 'full-access' || context.runtime === 'restricted'))
    throw new Error('permission-denied: 操作需要完全权限')
  if (
    operation.effect === 'external-write' &&
    (context.accessMode !== 'full-access' || context.runtime === 'restricted') &&
    (!context.capabilities.includes('http.request') ||
      !context.network?.some((rule) => rule.methods.some((method) => !['GET', 'HEAD'].includes(method))))
  )
    throw new Error('permission-denied: 未授权外部写入方法')
  if (operation.capabilities.some((v) => !context.capabilities.includes(v)))
    throw new Error('permission-denied: 操作所需能力未授权')
}
export function validateOperation(operation: PluginOperation) {
  if (
    !operation ||
    typeof operation.name !== 'string' ||
    operation.name.length > 80 ||
    !/^[a-zA-Z][\w-]*$/.test(operation.name) ||
    !operation.inputSchema ||
    !operation.outputSchema ||
    !Array.isArray(operation.audience) ||
    !operation.audience.length ||
    operation.audience.some((v) => !['ui', 'agent'].includes(v)) ||
    !['read', 'workspace-write', 'external-write', 'full-access'].includes(operation.effect) ||
    !Array.isArray(operation.capabilities) ||
    operation.capabilities.some((capability) => typeof capability !== 'string') ||
    typeof operation.execute !== 'function'
  )
    throw new Error('invalid-input: 插件操作描述无效')
}
