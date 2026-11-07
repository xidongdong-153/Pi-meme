import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  AuthorizationApproval,
  AuthorizationContext,
  AuthorizationEffect,
  AuthorizationOperation,
  AuthorizationRequest,
} from '@pi-meme/contracts/authorization'
import type { TransportIdentity } from '@pi-meme/contracts/transport-identity'
import type { AppSession } from '@pi-meme/contracts/app-host'
import { defaultAccessMode } from '@pi-meme/contracts/agent-access'
import type { AgentToolAuthorizationReply, AgentToolAuthorizationRequest } from '@pi-meme/contracts/system-tools'
import { AuthorizationError, AuthorizationService } from '@pi-meme/permissions/server/authorization-service'

function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function physicalTarget(input: string) {
  let current = path.resolve(input)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw cause
      tail.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
}

function resolverKey(context: Pick<AuthorizationContext, 'principal' | 'scope'>) {
  return JSON.stringify([
    context.principal.id,
    context.scope.hostId,
    context.scope.projectId,
    context.scope.sessionId,
    context.scope.clientId,
  ])
}

function inputCommitment(input: unknown) {
  const json = JSON.stringify(input) ?? 'null'
  const bytes = Buffer.byteLength(json)
  if (bytes > 64 * 1024 * 1024) throw new Error('permission-denied: 操作输入超过 64 MiB')
  return { algorithm: 'sha256-json', digest: createHash('sha256').update(json).digest('hex'), bytes }
}

type ToolRegistration = { resolver: () => Promise<AuthorizationContext> | AuthorizationContext; released: boolean }
type ActiveTool = {
  leaseId: string
  rawCallId: string
  registration: ToolRegistration
  dispose: () => void
  cancel: () => Promise<void>
}

/** Only private Host channels register identities and effect adapters. */
export class HostAuthorization {
  readonly authority: AuthorizationService
  private readonly identities = new AsyncLocalStorage<TransportIdentity | undefined>()
  private readonly contexts = new AsyncLocalStorage<AuthorizationContext>()
  private readonly signals = new AsyncLocalStorage<AbortSignal>()
  private readonly resolvers = new Map<string, () => Promise<AuthorizationContext> | AuthorizationContext>()
  private readonly tools = new Map<string, ActiveTool>()
  private readonly registrations = new Map<string, ToolRegistration>()
  private readonly approvals = new Map<string, (approval: AuthorizationApproval) => void>()
  private readonly startingTools = new Set<string>()
  identity() {
    return this.identities.getStore()
  }
  currentContext() {
    return this.contexts.getStore()
  }
  currentSignal() {
    return this.signals.getStore()
  }
  async cancelPrincipal(principalId: string, originalContext?: AuthorizationContext) {
    if (
      originalContext &&
      (originalContext.principal.id !== principalId || originalContext.scope.hostId !== this.hostId)
    )
      throw new Error('permission-denied: 取消主体与原始 Host 执行上下文不匹配')
    // Capture the OLD execution before awaits. A reused principal must not cancel its new run.
    const original = originalContext && {
      scope: { ...originalContext.scope },
      policyRevision: originalContext.policyRevision,
    }
    const sameScope = (left: AuthorizationContext['scope'], right: AuthorizationContext['scope']) =>
      left.hostId === right.hostId &&
      left.projectId === right.projectId &&
      left.sessionId === right.sessionId &&
      left.clientId === right.clientId
    const matches = (
      record: Pick<AuthorizationApproval, 'principalId' | 'scope' | 'policyRevision' | 'delegation'>,
    ) => {
      if (record.principalId === principalId)
        return (
          !original || (record.policyRevision === original.policyRevision && sameScope(record.scope, original.scope))
        )
      const delegation = record.delegation
      if (!delegation) return false
      if (!original)
        return (
          delegation.parentPrincipalId === principalId ||
          Boolean(delegation.ancestors?.some((ancestor) => ancestor.principalId === principalId))
        )
      if (
        delegation.ancestors?.some(
          (ancestor) =>
            ancestor.principalId === principalId &&
            ancestor.policyRevision === original.policyRevision &&
            sameScope(ancestor.scope, original.scope),
        )
      )
        return true
      // Older records may lack ancestors. The direct parent still binds its revision and scope ceiling.
      return (
        !delegation.ancestors?.length &&
        delegation.parentPrincipalId === principalId &&
        delegation.parentRevision === original.policyRevision &&
        delegation.scope.hostId === original.scope.hostId &&
        delegation.scope.projectId === original.scope.projectId &&
        delegation.scope.clientId === original.scope.clientId &&
        (delegation.scope.sessionId === undefined || delegation.scope.sessionId === original.scope.sessionId)
      )
    }
    const snapshot = this.authority.snapshot()
    const leases = snapshot.leases.filter((lease) => matches(lease) && ['prepared', 'running'].includes(lease.status))
    const leaseIds = new Set(leases.map((lease) => lease.id))
    // Match tools through their real journal lease, not a principal prefix or caller-supplied ancestry.
    await Promise.all(
      [...this.tools.values()].filter((tool) => leaseIds.has(tool.leaseId)).map((tool) => tool.cancel()),
    )
    for (const approval of snapshot.approvals) {
      if (!matches(approval) || approval.status !== 'pending') continue
      await this.authority.cancelApproval(approval.id)
      const cancelled = this.authority.snapshot().approvals.find((item) => item.id === approval.id)
      if (cancelled) this.approvals.get(approval.id)?.(cancelled)
    }
    for (const lease of leases) await this.authority.cancel(lease.id)
  }
  async cancelTools(principalId: string) {
    await Promise.all(
      [...this.tools].filter(([key]) => key.startsWith(`${principalId}\0`)).map(([, value]) => value.cancel()),
    )
  }
  async revoke(...args: Parameters<AuthorizationService['revoke']>) {
    await this.authority.revoke(...args)
    for (const approval of this.authority.snapshot().approvals)
      if (approval.status !== 'pending') this.approvals.get(approval.id)?.(approval)
  }

  constructor(
    private readonly hostId: string,
    private readonly instanceId: string,
    logPath: string,
  ) {
    this.authority = new AuthorizationService({
      hostId,
      logPath,
      resolveContext: (context) => {
        const resolver = this.resolvers.get(resolverKey(context)) ?? this.resolvers.get(context.principal.id)
        if (!resolver) throw new Error('scope-expired: 执行主体已释放')
        return resolver()
      },
      resolveParentContext: (delegation) =>
        (
          this.resolvers.get(
            resolverKey({ principal: { id: delegation.parentPrincipalId, kind: 'agent' }, scope: delegation.scope }),
          ) ?? this.resolvers.get(delegation.parentPrincipalId)
        )?.(),
    })
  }

  withIdentity<T>(identity: TransportIdentity, action: () => T): T {
    if (identity.hostId !== this.hostId) throw new Error('permission-denied: 认证身份不属于当前 Host')
    return this.identities.run(identity, action)
  }

  withContext<T>(context: AuthorizationContext, action: () => T): T {
    return this.contexts.run(context, action)
  }

  withServiceContext<T>(clientId: string, action: () => T): T {
    return this.identities.run(undefined, () => this.contexts.run(this.ownerContext(clientId), action))
  }

  context(clientId?: string) {
    return this.contexts.getStore() ?? this.ownerContext(clientId)
  }

  register(id: string, resolver: () => Promise<AuthorizationContext> | AuthorizationContext) {
    const registration: ToolRegistration = { resolver, released: false }
    this.registrations.set(id, registration)
    this.resolvers.set(id, resolver)
    // Each release only owns this registration, including a lost tool_result.
    let releasing: Promise<void> | undefined
    return () => {
      if (releasing) return releasing
      registration.released = true
      if (this.registrations.get(id) === registration) {
        this.registrations.delete(id)
        if (this.resolvers.get(id) === resolver) this.resolvers.delete(id)
      }
      const owned = [...this.tools].filter(([, tool]) => tool.registration === registration)
      releasing = (async () => {
        for (const [key, tool] of owned) {
          tool.dispose()
          await tool.cancel()
          await this.authority.complete(tool.leaseId, {
            status: 'outcome-unknown',
            reason: 'Worker 已释放但缺少工具终结结果',
          })
          if (this.tools.get(key) === tool) this.tools.delete(key)
        }
      })()
      return releasing
    }
  }

  ownerContext(clientId?: string): AuthorizationContext {
    const identity = this.identities.getStore()
    const principalId = identity ? `user:${identity.principalId}` : `service:${this.hostId}`
    const context: AuthorizationContext = {
      principal: { id: principalId, kind: identity ? 'user' : 'service' },
      scope: { hostId: this.hostId, ...(clientId ? { clientId } : {}) },
      policyRevision: this.instanceId,
      taskMode: 'default',
      accessMode: 'full-access',
      capabilities: [],
    }
    this.resolvers.set(resolverKey(context), () => context)
    return context
  }

  async userContext(clientId: string, readSession?: () => AppSession, administrative = false) {
    const inherited = this.contexts.getStore()
    if (inherited && inherited.principal.kind !== 'user' && inherited.principal.kind !== 'service') return inherited
    const base = this.ownerContext(clientId)
    if (!readSession || administrative || base.principal.kind !== 'user') return base
    const principalId = base.principal.id
    const resolve = (): AuthorizationContext => {
      const current = readSession()
      return {
        ...base,
        principal: { ...base.principal, id: principalId },
        scope: { ...base.scope, sessionId: current.sessionId, projectId: current.project?.projectId },
        policyRevision: createHash('sha256')
          .update(JSON.stringify([this.instanceId, current.configuration]))
          .digest('hex'),
        accessMode: current.configuration.accessMode ?? defaultAccessMode,
        taskMode: current.configuration.mode ?? 'default',
      }
    }
    const context = resolve()
    this.resolvers.set(resolverKey(context), resolve)
    return context
  }

  async respond(id: string, response: Parameters<AuthorizationService['respond']>[1]) {
    const approval = await this.authority.respond(id, response)
    this.approvals.get(id)?.(approval)
    return approval
  }

  private async start(request: AuthorizationRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    try {
      return await this.authority.start(request)
    } catch (cause) {
      if (!(cause instanceof AuthorizationError) || cause.code !== 'APPROVAL_REQUIRED') throw cause
    }
    const approval = await this.authority.requestApproval(request)
    const granted = await new Promise<AuthorizationApproval>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const abort = () => {
        cleanup()
        void this.authority.cancelApproval(approval.id)
        reject(new Error('approval-cancelled: 等待审批的执行已取消'))
      }
      const approvals = this.approvals
      function cleanup() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        approvals.delete(approval.id)
      }
      this.approvals.set(approval.id, (result) => {
        cleanup()
        resolve(result)
      })
      timer = setTimeout(abort, Math.max(1, approval.expiresAt - Date.now()))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    if (granted.status !== 'approved' || !granted.grantId) throw new Error('permission-denied: 本次操作未获批准')
    signal?.throwIfAborted()
    return this.authority.start({ ...request, grantId: granted.grantId })
  }

  async execute<T>(
    context: AuthorizationContext,
    operation: AuthorizationOperation,
    input: unknown,
    idempotencyKey: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    serviceConsent = false,
  ): Promise<T> {
    const request: AuthorizationRequest = { context, operation, input: inputCommitment(input), idempotencyKey }
    if (serviceConsent) request.grantId = (await this.authority.grantOperation(request)).id
    const started = await this.start(request, signal)
    const effectiveSignal = signal ? AbortSignal.any([signal, started.signal]) : started.signal
    try {
      effectiveSignal.throwIfAborted()
      const result = await this.withContext(context, () =>
        this.signals.run(effectiveSignal, () => action(effectiveSignal)),
      )
      await this.authority.complete(started.lease.id, {
        status: effectiveSignal.aborted ? 'outcome-unknown' : 'succeeded',
      })
      effectiveSignal.throwIfAborted()
      return result
    } catch (cause) {
      await this.authority.complete(started.lease.id, {
        status: 'outcome-unknown',
        reason: cause instanceof Error ? cause.message : '执行结果未知',
      })
      throw cause
    }
  }

  async tool(
    request: AgentToolAuthorizationRequest,
    options: {
      context: () => Promise<AuthorizationContext>
      principalId: string
      cwd: string
      protectedRoots: string[]
      readOnlyRoots?: string[]
      readableRoots: string[]
      writableRoots?: string[]
      knownTool: (name: string) => boolean
      abort: () => void
    },
    signal?: AbortSignal,
  ): Promise<AgentToolAuthorizationReply> {
    if (
      !request ||
      !['start', 'finish'].includes(request.phase) ||
      typeof request.operationId !== 'string' ||
      !/^toolop:v1:[a-f0-9]{64}$/.test(request.operationId) ||
      typeof request.callId !== 'string' ||
      !request.callId ||
      request.callId.length > 4096 ||
      request.callId.includes('\0')
    )
      throw new Error('permission-denied: 工具执行缺少合法的稳定操作 ID 或 Native 调用编号')
    const key = `${options.principalId}\0${request.operationId}`
    if (request.phase === 'finish') {
      if (typeof request.failed !== 'boolean') throw new Error('permission-denied: 工具终结状态无效')
      const pending = this.tools.get(key)
      if (!pending) return {}
      if (pending.rawCallId !== request.callId || pending.registration.resolver !== options.context)
        throw new Error('permission-denied: 工具终结结果不属于原调用或注册代次')
      pending.dispose()
      await this.authority.complete(pending.leaseId, {
        status: request.failed ? 'outcome-unknown' : 'succeeded',
        reason: request.failed ? '工具返回错误，不能推断已经发生的副作用被撤回' : undefined,
      })
      if (this.tools.get(key) === pending) this.tools.delete(key)
      return {}
    }
    const registration = this.registrations.get(options.principalId)
    const assertRegistration = () => {
      if (
        !registration ||
        registration.released ||
        registration.resolver !== options.context ||
        this.registrations.get(options.principalId) !== registration
      )
        throw new Error('scope-expired: 工具调用的 Worker 注册代次已释放或被替换')
    }
    assertRegistration()
    if (this.tools.has(key) || this.startingTools.has(request.operationId))
      throw new Error('permission-denied: 工具逻辑操作已经在启动或执行')
    // Authority's constructor restores its journal synchronously before this instance is usable.
    if (this.authority.hasRecordedOperation(request.operationId, 'tool.'))
      throw new Error('permission-denied: 该工具操作已有持久化记录，不能自动重放，请查看原结果')
    // Global across Worker principals: reopening the same native JSONL must not mint a fresh paid operation.
    this.startingTools.add(request.operationId)
    try {
      const context = await options.context()
      const effects: AuthorizationEffect[] = []
      const reply: AgentToolAuthorizationReply = {}
      const fileTools = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])
      if (fileTools.has(request.name)) {
        const raw = request.input.path ?? request.input.directory ?? '.'
        if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('permission-denied: 文件路径无效')
        const target = await physicalTarget(path.resolve(options.cwd, raw))
        const writing = request.name === 'write' || request.name === 'edit'
        for (const root of writing ? (options.readOnlyRoots ?? []) : [])
          if (within(await physicalTarget(root), target)) throw new Error('permission-denied: 不能修改拥有者运行时快照')
        for (const protectedRoot of options.protectedRoots) {
          const protectedPath = await physicalTarget(protectedRoot)
          if (
            within(protectedPath, target) &&
            !options.writableRoots?.some((root) => within(root, target)) &&
            (writing || !options.readableRoots.some((root) => within(root, target)))
          )
            throw new Error('permission-denied: Agent 不能访问 Host 私有数据或运行时')
        }
        effects.push({
          kind: writing ? 'fs.write' : 'fs.read',
          resource: target,
          boundary: within(await realpath(options.cwd), target) ? 'workspace' : 'external',
        })
        if (request.name === 'read') {
          const identity = await stat(target, { bigint: true })
          if (!identity.isFile() || identity.nlink !== 1n)
            throw new Error('permission-denied: 文件不是普通单链接对象，无法兑现秘密边界')
          reply.fileRead = { canonicalPath: target, dev: identity.dev.toString(), ino: identity.ino.toString() }
        }
        if (writing) {
          let identity
          try {
            identity = await lstat(target, { bigint: true })
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || request.name === 'edit') throw cause
          }
          if (identity && (!identity.isFile() || identity.nlink !== 1n || identity.ino === 0n))
            throw new Error('permission-denied: 修改目标不是可核对的普通单链接对象，无法兑现秘密边界')
          reply.fileMutation = {
            canonicalPath: target,
            existing: identity ? { dev: identity.dev.toString(), ino: identity.ino.toString() } : null,
          }
        }
      } else if (request.name === 'bash' || request.name === 'powershell') {
        effects.push({
          kind: context.taskMode === 'plan' || context.accessMode === 'read-only' ? 'process.read' : 'process.write',
          resource: await realpath(options.cwd),
          boundary: 'workspace',
        })
      } else if (['image_gen', 'save_plan', 'save_visualization'].includes(request.name)) {
        effects.push({ kind: 'artifact.write', resource: request.name, boundary: 'scratch' })
      } else if (request.name === 'manage_service') {
        effects.push({
          kind: ['list', 'logs'].includes(String(request.input.action)) ? 'process.read' : 'process.write',
          resource: await realpath(options.cwd),
          boundary: 'workspace',
        })
      } else {
        if (request.adapter !== 'mcp' && !options.knownTool(request.name))
          throw new Error(`permission-denied: 工具没有可信效果适配器：${request.name}`)
        effects.push({ kind: 'process.read', resource: `tool:${request.name}`, boundary: 'scratch' })
      }
      const native = ['bash', 'powershell', 'grep', 'find', 'ls'].includes(request.name)
      const requiredCapabilities = native
        ? ['host-secrets', 'process-tree', 'network-deny', 'environment-isolation']
        : []
      const missing = requiredCapabilities.filter((capability) => !context.capabilities.includes(capability))
      if (missing.length) throw new Error(`sandbox-unavailable: 执行环境不能兑现 ${missing.join(', ')}`)
      const operation: AuthorizationOperation = {
        id: `tool.${request.name}:${request.operationId}`,
        summary: effects.map((effect) => `${request.name}: ${effect.resource}`).join('; '),
        effects,
        requiredCapabilities,
        planArtifact: ['image_gen', 'save_plan', 'save_visualization'].includes(request.name),
      }
      const idempotencyKey = `tool:${request.operationId}`
      assertRegistration()
      const execution = await this.start(
        {
          context,
          operation,
          input: inputCommitment({ input: request.input, fileRead: reply.fileRead, fileMutation: reply.fileMutation }),
          idempotencyKey,
        },
        signal,
      )
      const stop = () => options.abort()
      execution.signal.addEventListener('abort', stop, { once: true })
      try {
        execution.signal.throwIfAborted()
        assertRegistration()
        this.tools.set(key, {
          leaseId: execution.lease.id,
          rawCallId: request.callId,
          registration: registration!,
          dispose: () => execution.signal.removeEventListener('abort', stop),
          cancel: () => this.authority.cancel(execution.lease.id),
        })
        return reply
      } catch (cause) {
        execution.signal.removeEventListener('abort', stop)
        await this.authority.complete(execution.lease.id, { status: 'outcome-unknown', reason: '工具启动前已撤权' })
        throw cause
      }
    } finally {
      this.startingTools.delete(request.operationId)
    }
  }

  async close() {
    await this.authority.drain()
    for (const approval of this.authority.snapshot().approvals) this.approvals.get(approval.id)?.(approval)
    for (const pending of this.tools.values()) {
      pending.dispose()
      await pending.cancel()
      await this.authority.complete(pending.leaseId, {
        status: 'outcome-unknown',
        reason: 'Host 已停止，缺少工具终结结果',
      })
    }
    this.tools.clear()
    await this.authority.close()
    this.resolvers.clear()
    this.registrations.clear()
  }
}
