import { randomUUID } from 'node:crypto'
import type {
  AuthorizationApproval,
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationDelegation,
  AuthorizationGrant,
  AuthorizationLease,
  AuthorizationRequest,
  AuthorizationScope,
  AuthorizationSnapshot,
} from '@pi-meme/contracts/authorization'
import {
  authorizationPolicyDenial,
  authorizationScopeContains,
  intersectCapabilities,
  isLocalReadOnlyOperation,
  presetEffects,
} from '../shared/authorization-policy'
import { AuthorizationJournal, authorizationDigest, canonicalAuthorizationJson } from './authorization-journal'

type Revocation = { id: string; scope: AuthorizationScope; policyRevision?: string; reason: string }
type Update =
  | { type: 'approval'; value: AuthorizationApproval }
  | { type: 'grant'; value: AuthorizationGrant }
  | { type: 'lease'; value: AuthorizationLease }
  | { type: 'revoke'; value: Revocation }
  | { type: 'resume'; id: string }

export type AuthorizationServiceOptions = {
  logPath: string
  hostId: string
  /** Resolve the authenticated actor and explicit execution target afresh. */
  resolveContext: (requested: AuthorizationContext) => AuthorizationContext | Promise<AuthorizationContext>
  /** Required for delegated actors; absence refuses delegation. */
  resolveParentContext?: (
    delegation: AuthorizationDelegation,
  ) => AuthorizationContext | undefined | Promise<AuthorizationContext | undefined>
  now?: () => number
  approvalTtlMs?: number
  drainTimeoutMs?: number
}

type Execution = { controller: AbortController; settled: Promise<void>; release: () => void }
const clone = <T>(value: T): T => JSON.parse(canonicalAuthorizationJson(value)) as T
function unconfirmedStatus(lease: AuthorizationLease): 'failed' | 'outcome-unknown' {
  return lease.localReadOnly === true && isLocalReadOnlyOperation(lease.operationId) ? 'failed' : 'outcome-unknown'
}

export class AuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

/** Host-owned authorization state. All decisions and one-shot consumption are serialized and durable. */
export class AuthorizationService {
  readonly bootId = randomUUID()
  private readonly approvals = new Map<string, AuthorizationApproval>()
  private readonly grants = new Map<string, AuthorizationGrant>()
  private readonly leases = new Map<string, AuthorizationLease>()
  private readonly revocations = new Map<string, Revocation>()
  private readonly running = new Map<string, Execution>()
  private readonly journal: AuthorizationJournal
  private queue: Promise<unknown> = Promise.resolve()
  private accepting = true
  private closed = false
  private readonly now: () => number

  constructor(private readonly options: AuthorizationServiceOptions) {
    if (!options.hostId) throw new Error('授权服务必须绑定 Host 身份')
    this.now = options.now ?? Date.now
    for (const value of [options.approvalTtlMs, options.drainTimeoutMs])
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('授权超时必须为有限正数')
    this.journal = new AuthorizationJournal(options.logPath, (payload) => this.restore(payload))
    const updates: Update[] = []
    for (const value of this.approvals.values())
      if (value.status === 'pending') updates.push({ type: 'approval', value: { ...value, status: 'cancelled' } })
    for (const value of this.grants.values())
      if (!value.revoked) updates.push({ type: 'grant', value: { ...value, revoked: true } })
    for (const value of this.leases.values())
      if (value.status === 'running' || value.status === 'prepared')
        updates.push({
          type: 'lease',
          value: {
            ...value,
            status: value.status === 'running' ? unconfirmedStatus(value) : 'cancelled',
            finishedAt: this.now(),
            reason: 'Host 已重启；恢复不自动重放操作',
          },
        })
    try {
      this.commit(updates)
    } catch (error) {
      this.journal.close()
      throw error
    }
  }

  private serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new AuthorizationError('AUTHORIZATION_CLOSED', '授权服务已关闭')
      return operation()
    })
    this.queue = result.catch(() => {})
    return result
  }

  private restore(payload: unknown) {
    if (!Array.isArray(payload)) throw new Error('授权日志事务格式无效')
    for (const item of payload) {
      if (!item || typeof item !== 'object' || !('type' in item)) throw new Error('授权日志事件无效')
      if (item.type === 'resume') {
        if (typeof item.id !== 'string') throw new Error('授权日志恢复事件无效')
        this.revocations.delete(item.id)
        continue
      }
      if (
        !['approval', 'grant', 'lease', 'revoke'].includes(item.type) ||
        !item.value ||
        typeof item.value !== 'object'
      )
        throw new Error('授权日志事件类型无效')
      const value = item.value as Record<string, unknown>
      if (
        typeof value.id !== 'string' ||
        !value.scope ||
        typeof value.scope !== 'object' ||
        !('hostId' in value.scope) ||
        value.scope.hostId !== this.options.hostId
      )
        throw new Error('授权日志目标不属于当前 Host')
      if (
        item.type !== 'revoke' &&
        (typeof value.bootId !== 'string' ||
          typeof value.principalId !== 'string' ||
          typeof value.policyRevision !== 'string' ||
          typeof value.inputDigest !== 'string')
      )
        throw new Error('授权日志身份无效')
      if (
        item.type === 'approval' &&
        (!['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(String(value.status)) ||
          typeof value.nonce !== 'string' ||
          typeof value.expiresAt !== 'number' ||
          typeof value.idempotencyKey !== 'string' ||
          !value.operation ||
          typeof value.operation !== 'object')
      )
        throw new Error('授权审批日志无效')
      if (
        item.type === 'grant' &&
        (typeof value.nonce !== 'string' || typeof value.expiresAt !== 'number' || typeof value.approvalId !== 'string')
      )
        throw new Error('授权凭证日志无效')
      if (
        item.type === 'lease' &&
        (!['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(
          String(value.status),
        ) ||
          typeof value.idempotencyKey !== 'string' ||
          typeof value.operationId !== 'string' ||
          typeof value.createdAt !== 'number' ||
          typeof value.expiresAt !== 'number' ||
          typeof value.nonce !== 'string' ||
          (value.localReadOnly !== undefined &&
            (value.localReadOnly !== true || !isLocalReadOnlyOperation(String(value.operationId)))))
      )
        throw new Error('授权执行日志无效')
      this.apply(item as Update)
    }
  }

  private apply(update: Update) {
    switch (update.type) {
      case 'approval':
        this.approvals.set(update.value.id, update.value)
        break
      case 'grant':
        this.grants.set(update.value.id, update.value)
        break
      case 'lease':
        this.leases.set(update.value.id, update.value)
        break
      case 'revoke':
        this.revocations.set(update.value.id, update.value)
        break
      case 'resume':
        this.revocations.delete(update.id)
        break
    }
  }

  private commit(updates: Update[]) {
    if (!updates.length) return
    const detached = clone(updates)
    try {
      this.journal.append(detached)
    } catch (error) {
      this.accepting = false
      for (const execution of this.running.values()) execution.controller.abort(error)
      throw error
    }
    for (const update of detached) this.apply(update)
  }

  private ensureAccepting() {
    if (!this.accepting) throw new AuthorizationError('AUTHORIZATION_DRAINING', '授权服务正在停止或日志不可用')
  }

  private async context(requested: AuthorizationContext, ancestors: string[] = []): Promise<AuthorizationContext> {
    if (ancestors.length >= 32 || ancestors.includes(requested.principal.id))
      throw new AuthorizationError('DELEGATION_CYCLE', '父代理委托链无效或过深')
    const context = clone(await this.options.resolveContext(clone(requested)))
    if (
      context.scope.hostId !== this.options.hostId ||
      context.principal.id !== requested.principal.id ||
      authorizationDigest(context.scope) !== authorizationDigest(requested.scope)
    )
      throw new AuthorizationError('ACTOR_MISMATCH', '授权主体或执行目标已变化')
    if (context.policyRevision !== requested.policyRevision)
      throw new AuthorizationError('POLICY_CHANGED', '授权策略已变化，请重新发起操作')
    if (context.delegation) {
      const candidate = await this.options.resolveParentContext?.(context.delegation)
      if (
        !candidate ||
        candidate.principal.id !== context.delegation.parentPrincipalId ||
        candidate.policyRevision !== context.delegation.parentRevision
      )
        throw new AuthorizationError('DELEGATION_REVOKED', '父代理委托已失效')
      const parent = await this.context(candidate, [...ancestors, context.principal.id])
      const ceiling = this.delegation(parent)
      context.delegation.ancestors = ceiling.ancestors
      context.delegation.effects = context.delegation.effects.filter((effect) => ceiling.effects.includes(effect))
      context.delegation.capabilities = intersectCapabilities(context.delegation.capabilities, ceiling.capabilities)
      if (!authorizationScopeContains(ceiling.scope, context.scope))
        throw new AuthorizationError('DELEGATION_SCOPE', '执行目标超出父代理范围')
    }
    for (const revocation of this.revocations.values())
      if (
        authorizationScopeContains(revocation.scope, context.scope) &&
        (!revocation.policyRevision || revocation.policyRevision === context.policyRevision)
      )
        throw new AuthorizationError('POLICY_REVOKED', revocation.reason)
    return context
  }

  private delegation(context: AuthorizationContext): AuthorizationDelegation {
    const effects = presetEffects(context.accessMode).filter(
      (effect) =>
        (!context.allowedEffects || context.allowedEffects.includes(effect)) &&
        (!context.delegation || context.delegation.effects.includes(effect)) &&
        (context.taskMode !== 'plan' || ['fs.read', 'network.read', 'process.read'].includes(effect)),
    )
    const { hostId, projectId, clientId } = context.scope
    return {
      parentPrincipalId: context.principal.id,
      parentRevision: context.policyRevision,
      ancestors: [
        ...(context.delegation?.ancestors ?? []),
        { principalId: context.principal.id, scope: context.scope, policyRevision: context.policyRevision },
      ],
      scope: { hostId, projectId, clientId },
      effects,
      capabilities: context.delegation
        ? intersectCapabilities(context.capabilities, context.delegation.capabilities)
        : [...context.capabilities],
    }
  }

  createDelegation(context: AuthorizationContext): Promise<AuthorizationDelegation> {
    return this.serialized(async () => clone(this.delegation(await this.context(context))))
  }

  private identity(request: AuthorizationRequest, context: AuthorizationContext) {
    if (!request.idempotencyKey || request.idempotencyKey.length > 512)
      throw new AuthorizationError('INVALID_IDEMPOTENCY_KEY', '操作必须提供稳定且不超过 512 字符的幂等键')
    const key = authorizationDigest({
      hostId: this.options.hostId,
      principalId: context.principal.id,
      key: request.idempotencyKey,
    })
    const digest = authorizationDigest({ context, operation: request.operation, input: request.input })
    return { key, digest }
  }

  private async admit(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    this.ensureAccepting()
    const context = await this.context(request.context)
    const denial = authorizationPolicyDenial(context, request.operation)
    if (denial) return { kind: 'deny', reason: denial }
    const { key, digest } = this.identity(request, context)
    const existing = [...this.leases.values()].find((lease) => lease.idempotencyKey === key)
    if (existing) {
      if (existing.inputDigest !== digest)
        throw new AuthorizationError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同输入或策略')
      if (existing.status === 'prepared' && existing.bootId === this.bootId) {
        if (existing.expiresAt <= this.now()) {
          this.commit([
            {
              type: 'lease',
              value: { ...existing, status: 'cancelled', finishedAt: this.now(), reason: '授权启动期限已过' },
            },
          ])
          return { kind: 'deny', reason: '授权启动期限已过，请重新确认操作' }
        }
        return { kind: 'allow', lease: clone(existing) }
      }
      throw new AuthorizationError(
        existing.status === 'outcome-unknown' ? 'EXECUTION_OUTCOME_UNKNOWN' : 'ALREADY_EXECUTED',
        `该操作已有记录：${existing.status}；不会自动重放`,
      )
    }
    const grant = request.grantId ? this.grants.get(request.grantId) : undefined
    if (
      request.grantId &&
      (!grant ||
        grant.bootId !== this.bootId ||
        grant.revoked ||
        grant.consumedBy ||
        grant.expiresAt <= this.now() ||
        grant.principalId !== context.principal.id ||
        grant.policyRevision !== context.policyRevision ||
        grant.inputDigest !== digest ||
        !authorizationScopeContains(grant.scope, context.scope))
    )
      throw new AuthorizationError('INVALID_GRANT', '单次授权已失效、已使用或与操作不匹配')
    const outsidePreset = request.operation.effects.some(
      (effect) =>
        !presetEffects(context.accessMode).includes(effect.kind) &&
        !(effect.kind === 'artifact.write' && request.operation.planArtifact && effect.boundary === 'scratch') &&
        !(context.principal.kind === 'user' && ['secret.read', 'policy.write'].includes(effect.kind)),
    )
    if ((request.operation.approvalRequired || outsidePreset) && !grant)
      return { kind: 'approval-required', reason: '该操作需要一次授权' }
    const lease: AuthorizationLease = {
      id: randomUUID(),
      nonce: randomUUID(),
      bootId: this.bootId,
      principalId: context.principal.id,
      scope: context.scope,
      policyRevision: context.policyRevision,
      inputDigest: digest,
      delegation: context.delegation,
      operationId: request.operation.id,
      localReadOnly: request.operation.localReadOnly,
      idempotencyKey: key,
      status: 'prepared',
      createdAt: this.now(),
      expiresAt: grant?.expiresAt ?? this.now() + (this.options.approvalTtlMs ?? 300_000),
    }
    this.commit([
      ...(grant ? [{ type: 'grant' as const, value: { ...grant, consumedBy: lease.id } }] : []),
      { type: 'lease', value: lease },
    ])
    return { kind: 'allow', lease: clone(lease) }
  }

  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const detached = clone(request)
    return this.serialized(() => this.admit(detached))
  }

  requestApproval(request: AuthorizationRequest): Promise<AuthorizationApproval> {
    const detached = clone(request)
    return this.serialized(async () => {
      this.ensureAccepting()
      const context = await this.context(detached.context)
      const denial = authorizationPolicyDenial(context, detached.operation)
      if (denial) throw new AuthorizationError('POLICY_DENIED', denial)
      const { key, digest } = this.identity(detached, context)
      if ([...this.leases.values()].some((lease) => lease.idempotencyKey === key))
        throw new AuthorizationError('ALREADY_EXECUTED', '该操作已有执行记录，不得重新审批重放')
      const existing = [...this.approvals.values()].find(
        (approval) =>
          approval.idempotencyKey === key &&
          approval.status === 'pending' &&
          approval.expiresAt > this.now() &&
          approval.bootId === this.bootId,
      )
      if (existing) {
        if (existing.inputDigest !== digest)
          throw new AuthorizationError('IDEMPOTENCY_CONFLICT', '审批幂等键对应不同输入')
        return clone(existing)
      }
      const approval: AuthorizationApproval = {
        id: randomUUID(),
        nonce: randomUUID(),
        bootId: this.bootId,
        principalId: context.principal.id,
        scope: context.scope,
        policyRevision: context.policyRevision,
        inputDigest: digest,
        delegation: context.delegation,
        operation: detached.operation,
        idempotencyKey: key,
        expiresAt: this.now() + (this.options.approvalTtlMs ?? 300_000),
        status: 'pending',
      }
      this.commit([{ type: 'approval', value: approval }])
      return clone(approval)
    })
  }

  /** Host cancels an unsubmitted operation without granting any execution authority. */
  cancelApproval(id: string): Promise<void> {
    return this.serialized(() => {
      const approval = this.approvals.get(id)
      if (approval?.status === 'pending')
        this.commit([{ type: 'approval', value: { ...approval, status: 'cancelled' } }])
    })
  }

  respond(
    id: string,
    response: { context: AuthorizationContext; nonce: string; decision: 'approve' | 'reject' },
  ): Promise<AuthorizationApproval> {
    const detached = clone(response)
    return this.serialized(async () => {
      this.ensureAccepting()
      const responder = await this.context(detached.context)
      const approval = this.approvals.get(id)
      if (
        !approval ||
        approval.status !== 'pending' ||
        approval.bootId !== this.bootId ||
        approval.nonce !== detached.nonce
      )
        throw new AuthorizationError('INVALID_APPROVAL', '审批请求已失效或响应不匹配')
      const { clientId: responderClient, ...responderScope } = responder.scope
      const { clientId: approvalClient, ...approvalScope } = approval.scope
      if (
        responder.principal.kind !== 'user' ||
        !authorizationScopeContains(responderScope, approvalScope) ||
        (approvalClient && responderClient !== approvalClient)
      )
        throw new AuthorizationError('APPROVAL_ACTOR_DENIED', '只有绑定客户端的已认证用户可以处理该审批')
      if (approval.expiresAt <= this.now()) {
        const expired: AuthorizationApproval = { ...approval, status: 'expired' }
        this.commit([{ type: 'approval', value: expired }])
        return clone(expired)
      }
      const granted = detached.decision === 'approve'
      const grant: AuthorizationGrant | undefined = granted
        ? {
            id: randomUUID(),
            approvalId: id,
            nonce: randomUUID(),
            bootId: this.bootId,
            principalId: approval.principalId,
            scope: approval.scope,
            policyRevision: approval.policyRevision,
            inputDigest: approval.inputDigest,
            delegation: approval.delegation,
            expiresAt: approval.expiresAt,
          }
        : undefined
      const resolved: AuthorizationApproval = {
        ...approval,
        status: granted ? 'approved' : 'rejected',
        ...(grant ? { grantId: grant.id } : {}),
      }
      this.commit([{ type: 'approval', value: resolved }, ...(grant ? [{ type: 'grant' as const, value: grant }] : [])])
      return clone(resolved)
    })
  }

  /** Call at tool_call; pair with complete only after the real tool body has settled. */
  start(request: AuthorizationRequest): Promise<{ lease: AuthorizationLease; signal: AbortSignal }> {
    const detached = clone(request)
    return this.serialized(async () => {
      const decision = await this.admit(detached)
      if (decision.kind !== 'allow')
        throw new AuthorizationError(decision.kind === 'deny' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED', decision.reason)
      const current = this.leases.get(decision.lease.id)!
      if (current.status !== 'prepared') throw new AuthorizationError('ALREADY_EXECUTED', '操作已开始')
      const lease: AuthorizationLease = { ...current, status: 'running' }
      const controller = new AbortController()
      let release!: () => void
      const settled = new Promise<void>((resolve) => {
        release = resolve
      })
      this.commit([{ type: 'lease', value: lease }])
      this.running.set(lease.id, { controller, settled, release })
      return { lease: clone(lease), signal: controller.signal }
    })
  }

  /** Host must wait for process/transport cleanup before calling this, not just request cancellation. */
  complete(
    id: string,
    outcome: { status: 'succeeded' | 'failed' | 'outcome-unknown'; reason?: string },
  ): Promise<void> {
    const detached = clone(outcome)
    return this.serialized(() => {
      if (!['succeeded', 'failed', 'outcome-unknown'].includes(detached.status)) throw new Error('执行结果无效')
      const lease = this.leases.get(id)
      if (!lease) throw new AuthorizationError('UNKNOWN_LEASE', '执行租约不存在')
      if (lease.status === 'prepared') throw new AuthorizationError('LEASE_NOT_STARTED', '执行租约尚未启动')
      const execution = this.running.get(id)
      if (lease.status === 'running')
        this.commit([
          {
            type: 'lease',
            value: {
              ...lease,
              status:
                execution?.controller.signal.aborted || detached.status === 'outcome-unknown'
                  ? unconfirmedStatus(lease)
                  : detached.status,
              reason: detached.reason,
              finishedAt: this.now(),
            },
          },
        ])
      execution?.release()
      this.running.delete(id)
    })
  }

  async execute<T>(
    request: AuthorizationRequest,
    body: (signal: AbortSignal, lease: AuthorizationLease) => Promise<T>,
  ): Promise<T> {
    const started = await this.start(request)
    try {
      started.signal.throwIfAborted()
      const value = await body(started.signal, started.lease)
      await this.complete(started.lease.id, { status: started.signal.aborted ? 'outcome-unknown' : 'succeeded' })
      if (started.signal.aborted)
        throw new AuthorizationError(
          started.lease.localReadOnly ? 'EXECUTION_CANCELLED' : 'EXECUTION_OUTCOME_UNKNOWN',
          started.lease.localReadOnly ? '本地状态读取或订阅已取消' : '操作已撤销；已发生的效果无法自动撤回',
        )
      return value
    } catch (error) {
      if (!this.closed)
        await this.complete(started.lease.id, {
          status: 'outcome-unknown',
          reason: error instanceof Error ? error.message : '操作结果未知',
        })
      throw error
    }
  }

  /** Host-only bridge for an already established, explicit per-service user consent. No ceiling is bypassed. */
  grantOperation(request: AuthorizationRequest): Promise<AuthorizationGrant> {
    const detached = clone(request)
    return this.serialized(async () => {
      this.ensureAccepting()
      const context = await this.context(detached.context)
      const denial = authorizationPolicyDenial(context, detached.operation)
      if (denial) throw new AuthorizationError('POLICY_DENIED', denial)
      const { key, digest } = this.identity(detached, context)
      if ([...this.leases.values()].some((lease) => lease.idempotencyKey === key))
        throw new AuthorizationError('ALREADY_EXECUTED', '该操作已有执行记录')
      const approvalId = randomUUID()
      const grant: AuthorizationGrant = {
        id: randomUUID(),
        approvalId,
        nonce: randomUUID(),
        bootId: this.bootId,
        principalId: context.principal.id,
        scope: context.scope,
        policyRevision: context.policyRevision,
        inputDigest: digest,
        delegation: context.delegation,
        expiresAt: this.now() + (this.options.approvalTtlMs ?? 300_000),
      }
      const approval: AuthorizationApproval = {
        id: approvalId,
        nonce: randomUUID(),
        bootId: this.bootId,
        principalId: context.principal.id,
        scope: context.scope,
        policyRevision: context.policyRevision,
        inputDigest: digest,
        delegation: context.delegation,
        operation: detached.operation,
        idempotencyKey: key,
        expiresAt: grant.expiresAt,
        status: 'approved',
        grantId: grant.id,
      }
      this.commit([
        { type: 'approval', value: approval },
        { type: 'grant', value: grant },
      ])
      return clone(grant)
    })
  }

  private scopeMatches(
    scope: AuthorizationScope,
    value: { scope: AuthorizationScope; policyRevision: string; delegation?: AuthorizationDelegation },
    revision?: string,
  ) {
    return (
      (authorizationScopeContains(scope, value.scope) && (!revision || value.policyRevision === revision)) ||
      value.delegation?.ancestors?.some(
        (ancestor) =>
          authorizationScopeContains(scope, ancestor.scope) && (!revision || ancestor.policyRevision === revision),
      ) === true
    )
  }

  private stop(scope: AuthorizationScope, reason: string, policyRevision?: string): Update[] {
    const matches = (value: {
      scope: AuthorizationScope
      policyRevision: string
      delegation?: AuthorizationDelegation
    }) => this.scopeMatches(scope, value, policyRevision)
    const updates: Update[] = []
    for (const value of this.approvals.values())
      if (matches(value) && value.status === 'pending')
        updates.push({ type: 'approval', value: { ...value, status: 'cancelled' } })
    for (const value of this.grants.values())
      if (matches(value) && !value.revoked) updates.push({ type: 'grant', value: { ...value, revoked: true } })
    for (const value of this.leases.values())
      if (matches(value) && ['prepared', 'running'].includes(value.status))
        updates.push({
          type: 'lease',
          value: {
            ...value,
            status: value.status === 'prepared' ? 'cancelled' : unconfirmedStatus(value),
            reason,
            finishedAt: this.now(),
          },
        })
    return updates
  }

  revoke(scope: AuthorizationScope, reason = '授权已撤销', policyRevision?: string): Promise<void> {
    const detached = clone(scope)
    return this.serialized(() => {
      if (detached.hostId !== this.options.hostId)
        throw new AuthorizationError('SCOPE_MISMATCH', '撤权目标不属于当前 Host')
      this.commit([
        { type: 'revoke', value: { id: randomUUID(), scope: detached, policyRevision, reason } },
        ...this.stop(detached, reason, policyRevision),
      ])
      for (const [id, execution] of this.running) {
        const lease = this.leases.get(id)!
        if (this.scopeMatches(detached, lease, policyRevision)) execution.controller.abort(new Error(reason))
      }
    })
  }

  /** Host-only explicit reopening; this does not revive grants, approvals or leases. */
  resume(scope: AuthorizationScope): Promise<void> {
    return this.serialized(() => {
      this.ensureAccepting()
      this.commit(
        [...this.revocations.values()]
          .filter((value) => authorizationDigest(value.scope) === authorizationDigest(scope))
          .map((value) => ({ type: 'resume' as const, id: value.id })),
      )
    })
  }

  cancel(leaseId: string, reason = '操作已取消'): Promise<void> {
    return this.serialized(() => {
      const value = this.leases.get(leaseId)
      if (!value || !['prepared', 'running'].includes(value.status)) return
      this.commit([
        {
          type: 'lease',
          value: {
            ...value,
            status: value.status === 'prepared' ? 'cancelled' : unconfirmedStatus(value),
            reason,
            finishedAt: this.now(),
          },
        },
      ])
      this.running.get(leaseId)?.controller.abort(new Error(reason))
    })
  }

  /** Query durable operation references without cloning the complete journal state. */
  hasRecordedOperation(reference: string, namespace?: string): boolean {
    if (!reference || reference.length > 512 || reference.includes('\0') || (namespace && namespace.length > 128))
      throw new Error('操作记录标识无效')
    const matches = (id: string) =>
      id === reference || Boolean(namespace && id.startsWith(namespace) && id.endsWith(`:${reference}`))
    for (const lease of this.leases.values()) if (matches(lease.operationId)) return true
    for (const approval of this.approvals.values()) if (matches(approval.operation.id)) return true
    return false
  }

  snapshot(scope?: AuthorizationScope): AuthorizationSnapshot {
    const visible = (value: { scope: AuthorizationScope }) => !scope || authorizationScopeContains(scope, value.scope)
    return structuredClone({
      bootId: this.bootId,
      scope: scope ?? { hostId: this.options.hostId },
      accepting: this.accepting && !this.closed,
      revocations: [...this.revocations.values()].filter(visible),
      approvals: [...this.approvals.values()].filter(visible),
      grants: [...this.grants.values()].filter(visible),
      leases: [...this.leases.values()].filter(visible),
    })
  }

  async drain(): Promise<{ outcomeUnknown: string[] }> {
    const pending = await this.serialized(() => {
      this.accepting = false
      this.commit(this.stop({ hostId: this.options.hostId }, 'Host 正在停止'))
      for (const execution of this.running.values()) execution.controller.abort(new Error('Host 正在停止'))
      return [...this.running.values()].map((execution) => execution.settled)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.drainTimeoutMs ?? 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    return {
      outcomeUnknown: [...this.leases.values()]
        .filter((lease) => lease.status === 'outcome-unknown')
        .map((lease) => lease.id),
    }
  }

  /** Call after drain; lingering executions retain outcome-unknown in the durable log. */
  async close(): Promise<void> {
    await this.drain()
    await this.serialized(() => {
      this.journal.close()
      this.closed = true
    })
  }
}
