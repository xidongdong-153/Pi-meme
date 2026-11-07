import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type {
  AuthorizationContext,
  AuthorizationEffectKind,
  AuthorizationOperation,
  AuthorizationScope,
} from '@pi-meme/contracts/authorization'

export const authorizationEffects: readonly AuthorizationEffectKind[] = [
  'fs.read',
  'fs.write',
  'network.read',
  'network.write',
  'process.read',
  'process.write',
  'host.write',
  'policy.write',
  'secret.read',
  'artifact.write',
]
const readEffects: readonly AuthorizationEffectKind[] = ['fs.read', 'network.read', 'process.read']
const localReadOnlyOperations = new Set([
  'transport:subscription:events',
  'transport:subscription:control-events',
  'api.events.read',
  'api.events.subscribe',
])

export function isLocalReadOnlyOperation(id: string) {
  return localReadOnlyOperations.has(id)
}

export function presetEffects(mode: AgentAccessMode): readonly AuthorizationEffectKind[] {
  if (mode === 'read-only') return readEffects
  if (mode === 'workspace-write') return [...readEffects, 'fs.write', 'process.write', 'artifact.write']
  return authorizationEffects.filter((effect) => effect !== 'secret.read' && effect !== 'policy.write')
}

export function intersectCapabilities(...sets: readonly (readonly string[])[]): string[] {
  if (!sets.length) return []
  return [...new Set(sets[0])].filter((value) => sets.every((set) => set.includes(value)))
}

/** Missing dimensions in the ceiling are unrestricted, not wildcards supplied by a caller. */
export function authorizationScopeContains(ceiling: AuthorizationScope, target: AuthorizationScope): boolean {
  return (
    ceiling.hostId === target.hostId &&
    (['projectId', 'sessionId', 'clientId'] as const).every(
      (key) => ceiling[key] === undefined || ceiling[key] === target[key],
    )
  )
}

/** Approval cannot override this policy or add a missing backend capability. */
export function authorizationPolicyDenial(
  context: AuthorizationContext,
  operation: AuthorizationOperation,
): string | undefined {
  if (!context.principal.id || !context.scope.hostId || !context.policyRevision || !operation.id)
    return '授权主体、目标或策略版本无效'
  if (!['read-only', 'workspace-write', 'full-access'].includes(context.accessMode)) return '未知访问权限模式'
  if (!['plan', 'default'].includes(context.taskMode)) return '未知任务模式'
  if (!operation.effects.length) return '操作必须声明完整效果'
  if (
    operation.localReadOnly !== undefined &&
    (operation.localReadOnly !== true ||
      !isLocalReadOnlyOperation(operation.id) ||
      operation.effects.some((effect) => effect.kind !== 'process.read' || effect.boundary !== 'host'))
  )
    return '本地只读标记仅允许命名的 Host 状态读取和事件订阅'
  const delegation = context.delegation
  if (delegation && !authorizationScopeContains(delegation.scope, context.scope)) return '操作超出父代理委托范围'
  const capabilities = delegation
    ? intersectCapabilities(context.capabilities, delegation.capabilities)
    : context.capabilities
  if (operation.requiredCapabilities?.some((capability) => !capabilities.includes(capability)))
    return '执行环境无法兑现操作需要的隔离能力'
  for (const effect of operation.effects) {
    if (!authorizationEffects.includes(effect.kind) || !effect.resource) return '操作包含未知效果或空资源'
    const artifact =
      effect.kind === 'artifact.write' && operation.planArtifact === true && effect.boundary === 'scratch'
    if (
      (context.taskMode === 'plan' || context.accessMode === 'read-only') &&
      !readEffects.includes(effect.kind) &&
      !artifact
    )
      return '规划或只读权限禁止该操作效果'
    if (
      (effect.kind === 'secret.read' || effect.kind === 'policy.write') &&
      context.principal.kind !== 'user' &&
      !context.allowedEffects?.includes(effect.kind)
    )
      return '该主体没有凭据或策略管理权限'
    if (context.allowedEffects && !context.allowedEffects.includes(effect.kind)) return '操作超出安装或会话权限上限'
    if (delegation && !delegation.effects.includes(effect.kind)) return '操作超出父代理委托权限上限'
    if (
      context.accessMode === 'workspace-write' &&
      ['fs.write', 'process.write', 'artifact.write'].includes(effect.kind) &&
      effect.boundary !== 'workspace' &&
      effect.boundary !== 'scratch'
    )
      return '工作区权限禁止修改项目外资源'
  }
  return undefined
}
