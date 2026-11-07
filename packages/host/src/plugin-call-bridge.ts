import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { SessionRef, ProjectRef } from '@pi-meme/contracts/app-host'
import type { PluginRuntimeRequest, RestrictedRegistration } from '@pi-meme/contracts/plugin-call'
import { assertExecutionRequirements, type ExecutionCapabilityReport } from '@pi-meme/contracts/execution-capabilities'
import type { PluginCallContext, PluginEffect, JsonValue } from '@pi-meme/plugin-sdk/rpc'
import type { PluginOperation } from '@pi-meme/plugin-sdk/server'
import type { PluginHttpRequest } from '@pi-meme/plugin-sdk/restricted'
import type { PluginGrant } from '@pi-meme/plugin-sdk/permissions'
import type { PluginLease, PluginManager } from '@pi-meme/plugin-runtime/manager'
import { RestrictedRunner } from '@pi-meme/plugin-runtime/restricted-runner'
import { authorizeOperation, checkSchema, checkedJson, validateOperation } from '@pi-meme/plugin-runtime/operation'
import { pluginSandboxLaunch } from './plugin-sandbox'
import type { PluginHttpBroker } from './plugin-http-broker'

export type PluginExecutionOperation = {
  kind: 'tool' | 'command' | 'hook' | 'server' | 'http' | 'shared-data'
  name: string
  effect: PluginEffect
  capabilities: readonly string[]
}

export function allowedRestrictedContribution(
  value: { effect: string; capabilities: readonly string[] },
  actor: Pick<AgentSummary, 'mode' | 'accessMode'>,
  grant: PluginGrant,
) {
  if (
    !['read', 'workspace-write', 'external-write'].includes(value.effect) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((capability) => !grant.restricted.capabilities?.includes(capability as never))
  )
    return false
  if (actor.mode === 'plan' || actor.accessMode === 'read-only') return value.effect === 'read'
  if (value.effect === 'read') return true
  if (value.effect === 'workspace-write')
    return (
      grant.restricted.maxAccess === 'workspace-write' &&
      grant.restricted.capabilities?.includes('workspace.write') === true
    )
  return (
    value.effect === 'external-write' &&
    grant.restricted.capabilities?.includes('http.request') === true &&
    grant.restricted.network?.some((rule) => rule.methods.some((method) => !['GET', 'HEAD'].includes(method))) === true
  )
}

function record(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function name(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && /^[a-zA-Z][\w-]*$/.test(value)
}
const effects = ['read', 'workspace-write', 'external-write', 'full-access']
const reservedToolNames = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'codemode',
  'tool_search',
  'request_user_input',
  'save_visualization',
  'read_visualization',
  'save_plan',
  'spawn_agent',
  'send_message',
  'wait_agent',
  'finish_agent',
  'list_agents',
  'list_agent_models',
  'followup_task',
  'interrupt_agent',
  'get_goal',
  'update_goal',
  'manage_service',
  'system_read',
  'system_write',
])

export function createPluginCallBridge(options: {
  lease: PluginLease
  manager: PluginManager
  actor: () => AgentSummary
  sessionRef: () => Promise<SessionRef & { project?: ProjectRef }>
  node: string
  runnerEntry?: string
  dataRoot: string
  reservedNames?: ReadonlySet<string>
  sandboxCapability: { supported: boolean; reason?: string; report?: ExecutionCapabilityReport }
  http: PluginHttpBroker
  executeOperation: (
    definition: PluginExecutionOperation,
    context: PluginCallContext,
    input: JsonValue,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<JsonValue>,
  ) => Promise<JsonValue>
  ui: (
    input: { pluginId: string; generation: number; method: string; input: unknown },
    signal: AbortSignal,
  ) => Promise<unknown>
}) {
  const metadata = new Map<string, { key: string; raw: RestrictedRegistration; visible: RestrictedRegistration }>()
  const tails = new Map<string, Promise<unknown>>()
  const closeEpochs = new Map<string, number>()
  const active = new Set<{ pluginId: string; controller: AbortController; done: Promise<void> }>()
  const snapshot = () => ({ ...options.actor() })
  const same = (actor: AgentSummary) => {
    const current = options.actor()
    if (
      actor.agentId !== current.agentId ||
      actor.epoch !== current.epoch ||
      actor.executionGeneration !== current.executionGeneration ||
      actor.runId !== current.runId ||
      actor.mode !== current.mode ||
      actor.accessMode !== current.accessMode ||
      actor.cwd !== current.cwd
    )
      throw new Error('scope-expired: 插件执行主体、运行或权限已经改变')
  }
  const assertLive = (actor: AgentSummary) => {
    same(actor)
    if (!actor.runId || !['starting', 'running', 'waiting_input', 'waiting_children'].includes(options.actor().status))
      throw new Error('scope-expired: 没有有效执行 scope')
  }
  const entryFor = (request: PluginRuntimeRequest) => {
    const entry = options.lease.agentEntries.find(
      (item) => item.pluginId === request.pluginId && item.generation === request.generation,
    )
    const current = options.manager.getGeneration(request.pluginId, request.generation)
    if (
      !entry ||
      !current?.enabled ||
      !entry.grant ||
      !options.manager.isGrantCurrent(request.pluginId, request.generation, entry.grant.revision) ||
      current.policyHash !== entry.grant.policyHash
    )
      throw new Error('policy-changed: 插件未选择、代次过期或授权改变')
    if (entry.trusted || !entry.restricted || !entry.directory)
      throw new Error('unsupported-sdk: Agent 插件必须使用 SDK 4 受限入口')
    return entry
  }
  const capability = (writable: boolean) => {
    const report = options.sandboxCapability.report
    if (!options.sandboxCapability.supported || !report)
      throw new Error(`sandbox-unavailable: ${options.sandboxCapability.reason ?? '缺少受限插件能力报告'}`)
    assertExecutionRequirements(report, [
      'host-secrets',
      'network-deny',
      'process-tree',
      'environment-isolation',
      'filesystem-write-boundary',
      'unix-socket-deny',
    ])
    if (writable) assertExecutionRequirements(report, ['hardlink-write-boundary'])
  }
  const track = async <T>(
    pluginId: string,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (active.size >= 64) throw new Error('permission-denied: 插件执行数量过多')
    let finish!: () => void
    const entry = {
      pluginId,
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
    }
    active.add(entry)
    try {
      const effective = AbortSignal.any([signal, entry.controller.signal])
      effective.throwIfAborted()
      return await action(effective)
    } finally {
      active.delete(entry)
      entry.controller.abort()
      finish()
    }
  }
  const context = async (
    request: PluginRuntimeRequest,
    actor: AgentSummary,
    signal: AbortSignal,
  ): Promise<PluginCallContext> => {
    const session = await options.sessionRef()
    same(actor)
    const grant = entryFor(request).grant!
    return {
      pluginId: request.pluginId,
      generation: request.generation,
      policyHash: grant.policyHash,
      origin: 'agent',
      target: { hostId: session.hostId, session, project: session.project },
      agentId: actor.agentId,
      runId: actor.runId,
      epoch: actor.epoch,
      executionGeneration: actor.executionGeneration,
      mode: actor.mode,
      runtime: 'restricted',
      accessMode: actor.accessMode,
      workspaceWritable:
        actor.mode !== 'plan' &&
        actor.accessMode !== 'read-only' &&
        grant.restricted.maxAccess === 'workspace-write' &&
        grant.restricted.capabilities?.includes('workspace.write') === true,
      capabilities: grant.restricted.capabilities ?? [],
      network: grant.restricted.network ?? [],
      signal,
      requestId: crypto.randomUUID(),
    }
  }
  const validateRegistration = (value: RestrictedRegistration) => {
    checkedJson(value, 1048576)
    if (
      !value ||
      !Array.isArray(value.tools) ||
      !Array.isArray(value.commands) ||
      !Array.isArray(value.hooks) ||
      !Array.isArray(value.operations) ||
      value.tools.length + value.commands.length + value.operations.length > 128 ||
      value.hooks.length > 5
    )
      throw new Error('invalid-output: 插件注册无效或过多')
    for (const items of [value.tools, value.commands]) {
      const names = new Set<string>()
      for (const item of items) {
        if (
          !name(item.name) ||
          reservedToolNames.has(item.name) ||
          options.reservedNames?.has(item.name) ||
          names.has(item.name) ||
          !effects.includes(item.effect) ||
          !Array.isArray(item.capabilities) ||
          item.capabilities.some((cap) => typeof cap !== 'string')
        )
          throw new Error('invalid-output: 插件工具名称、效果或能力无效')
        names.add(item.name)
      }
    }
    for (const tool of value.tools) if (!record(tool.parameters)) throw new Error('invalid-output: 工具 schema 无效')
    const names = new Set<string>()
    for (const operation of value.operations) {
      validateOperation({ ...operation, execute: async () => null } as PluginOperation)
      if (names.has(operation.name)) throw new Error('invalid-output: Server 操作重复')
      names.add(operation.name)
    }
    if (
      value.hooks.some((hook) => !['sessionStart', 'sessionEnd', 'beforeRun', 'runStart', 'runEnd'].includes(hook)) ||
      new Set(value.hooks).size !== value.hooks.length
    )
      throw new Error('invalid-output: 插件 Hook 无效')
  }

  const withRunner = async <T>(
    request: PluginRuntimeRequest,
    actor: AgentSummary,
    effect: PluginEffect,
    signal: AbortSignal,
    depth: number,
    action: (runner: RestrictedRunner, registration: RestrictedRegistration) => Promise<T>,
    discovery = false,
  ): Promise<T> => {
    if (depth > 8) throw new Error('permission-denied: 插件嵌套调用过深')
    capability(effect === 'workspace-write')
    if (discovery) same(actor)
    else assertLive(actor)
    signal.throwIfAborted()
    const entry = entryFor(request)
    const grant = entry.grant!
    const scratch = await mkdtemp(path.join(tmpdir(), 'pi-plugin-call-'))
    let runner: RestrictedRunner | undefined
    const abort = () => {
      void runner?.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      runner = new RestrictedRunner({
        node: options.node,
        entry: options.runnerEntry ?? RestrictedRunner.entry,
        workspace: actor.cwd,
        directory: entry.directory!,
        scratch,
        dataRoot: options.dataRoot,
        readable: grant.restricted.capabilities?.includes('workspace.read') === true,
        writable: effect === 'workspace-write',
        launch: pluginSandboxLaunch,
        initialize: {
          pluginId: entry.pluginId,
          generation: entry.generation,
          agent: entry.restricted,
          server: entry.restrictedServer,
        },
        broker: async (method, input, cancellation) => {
          same(actor)
          entryFor(request)
          assertLive(actor)
          const currentSignal = AbortSignal.any([signal, cancellation])
          currentSignal.throwIfAborted()
          const data = record(input) ? input : {}
          const ctx = await context(request, actor, currentSignal)
          if (method === 'http') {
            const http = input as PluginHttpRequest
            const verb = String(http?.method ?? '').toUpperCase()
            const read = ['GET', 'HEAD'].includes(verb)
            if (!read && (effect !== 'external-write' || actor.mode === 'plan' || actor.accessMode === 'read-only'))
              throw new Error('permission-denied: 当前操作只允许只读网络方法')
            return options.executeOperation(
              { kind: 'http', name: verb, effect: read ? 'read' : 'external-write', capabilities: ['http.request'] },
              ctx,
              checkedJson(input),
              currentSignal,
              async (leaseSignal) =>
                checkedJson(
                  await options.http.request(
                    entry.pluginId,
                    grant,
                    read || actor.mode === 'plan' || actor.accessMode === 'read-only' ? 'plan' : 'default',
                    http,
                    AbortSignal.any([currentSignal, leaseSignal]),
                  ),
                ),
            )
          }
          if (method === 'sharedData') {
            if (
              typeof data.key !== 'string' ||
              !grant.restricted.capabilities?.includes('sharedData.read') ||
              !grant.restricted.sharedData?.includes(data.key)
            )
              throw new Error('permission-denied: 未授权共享记录')
            return options.executeOperation(
              { kind: 'shared-data', name: data.key, effect: 'read', capabilities: ['sharedData.read'] },
              ctx,
              checkedJson(input),
              currentSignal,
              async (leaseSignal) => {
                leaseSignal.throwIfAborted()
                same(actor)
                entryFor(request)
                return checkedJson(
                  options.manager.readSharedData(
                    entry.pluginId,
                    data.key as string,
                    ctx.target.project?.projectId ?? ctx.target.session!.sessionId,
                  ),
                )
              },
            )
          }
          if (method === 'server') {
            if (!name(data.operation)) throw new Error('invalid-input: Server 操作名无效')
            return execute(
              {
                ...request,
                action: 'server',
                name: data.operation,
                input: Object.hasOwn(data, 'input') ? data.input : {},
              },
              actor,
              currentSignal,
              depth + 1,
              effect,
            )
          }
          if (['interaction', 'notify', 'status', 'message'].includes(method)) {
            if (method === 'interaction' && !grant.restricted.capabilities?.includes('interaction.request'))
              throw new Error('permission-denied: 未授权提问')
            const result = await options.ui(
              { pluginId: entry.pluginId, generation: entry.generation, method, input },
              currentSignal,
            )
            same(actor)
            entryFor(request)
            return result
          }
          throw new Error('permission-denied: 未知受限 broker')
        },
      })
      signal.throwIfAborted()
      const registration = await runner.start()
      same(actor)
      entryFor(request)
      signal.throwIfAborted()
      validateRegistration(registration)
      // 初始化与生命周期没有 broker scope，发现过程始终只读且不会获得 Host API。
      if (discovery && registration.hooks.includes('sessionStart'))
        await runner.call(
          'hook',
          {
            name: 'sessionStart',
            event: { session: { id: actor.sessionId ?? actor.sessionKey, cwd: actor.cwd } },
          },
          AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        )
      return await action(runner, registration)
    } finally {
      signal.removeEventListener('abort', abort)
      await runner?.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }

  const discover = async (request: PluginRuntimeRequest, actor: AgentSummary, signal: AbortSignal) => {
    const entry = entryFor(request)
    const key = JSON.stringify([
      entry.generation,
      entry.grant!.policyHash,
      entry.grant!.revision,
      actor.mode,
      actor.accessMode,
    ])
    const cached = metadata.get(request.pluginId)
    if (cached?.key === key) return cached
    return track(request.pluginId, signal, (currentSignal) =>
      withRunner(
        request,
        actor,
        'read',
        currentSignal,
        0,
        async (_runner, raw) => {
          const allowed = (value: { effect: string; capabilities: string[] }) =>
            allowedRestrictedContribution(value, actor, entry.grant!)
          const visible = { ...raw, tools: raw.tools.filter(allowed), commands: raw.commands.filter(allowed) }
          if (
            raw.tools.length + raw.commands.length > 0 &&
            !visible.tools.length &&
            !visible.commands.length &&
            !raw.hooks.length
          )
            throw new Error('grant-required: 当前模式或 SDK 4 运行时没有可用的获准工具或命令')
          const item = { key, raw, visible }
          metadata.set(request.pluginId, item)
          return item
        },
        true,
      ),
    )
  }

  async function execute(
    request: PluginRuntimeRequest,
    actor: AgentSummary,
    signal: AbortSignal,
    depth = 0,
    parentEffect?: PluginEffect,
  ): Promise<JsonValue> {
    if (depth > 8) throw new Error('permission-denied: 插件嵌套调用过深')
    assertLive(actor)
    signal.throwIfAborted()
    const { raw, visible } = await discover(request, actor, signal)
    const input = checkedJson(request.input ?? {})
    let definition: PluginExecutionOperation
    let target: unknown
    if (request.action === 'tool' || request.action === 'command') {
      target = (request.action === 'tool' ? visible.tools : visible.commands).find((item) => item.name === request.name)
      if (!target) throw new Error('permission-denied: 插件工具或命令未授权')
      const selected = target as RestrictedRegistration['tools'][number]
      definition = {
        kind: request.action,
        name: selected.name,
        effect: selected.effect as PluginEffect,
        capabilities: selected.capabilities,
      }
      if (!record(input)) throw new Error('invalid-input: 工具参数无效')
      if (request.action === 'tool') checkSchema(selected.parameters, input.parameters)
    } else if (request.action === 'server') {
      target = raw.operations.find((item) => item.name === request.name)
      if (!target) throw new Error('operation-unavailable-in-runtime: Server 无对应操作')
      const operation = target as Omit<PluginOperation, 'execute'>
      definition = {
        kind: 'server',
        name: operation.name,
        effect: operation.effect,
        capabilities: operation.capabilities,
      }
      checkSchema(operation.inputSchema, input)
    } else if (request.action === 'hook' && raw.hooks.includes(request.name!)) {
      target = request.name
      definition = { kind: 'hook', name: request.name!, effect: 'read', capabilities: [] }
    } else throw new Error('operation-unavailable-in-runtime: 插件调用入口无效')
    if (parentEffect && definition.effect !== 'read' && definition.effect !== parentEffect)
      throw new Error('permission-denied: 嵌套 Server 操作超出父操作效果')
    return track(request.pluginId, signal, async (currentSignal) => {
      const ctx = await context(request, actor, currentSignal)
      if (definition.kind === 'server') authorizeOperation(target as Omit<PluginOperation, 'execute'>, ctx)
      if (
        !allowedRestrictedContribution(
          { effect: definition.effect, capabilities: definition.capabilities },
          actor,
          entryFor(request).grant!,
        )
      )
        throw new Error('permission-denied: 当前模式或插件授权不允许此效果')
      return options.executeOperation(definition, ctx, input, currentSignal, async (leaseSignal) => {
        const effective = AbortSignal.any([currentSignal, leaseSignal])
        return withRunner(request, actor, definition.effect, effective, depth, async (runner, registration) => {
          const actual =
            definition.kind === 'server'
              ? registration.operations.find((item) => item.name === definition.name)
              : definition.kind === 'hook'
                ? registration.hooks.find((item) => item === definition.name)
                : (definition.kind === 'tool' ? registration.tools : registration.commands).find(
                    (item) => item.name === definition.name,
                  )
          if (JSON.stringify(actual) !== JSON.stringify(target))
            throw new Error('policy-changed: 插件执行时改变了注册定义')
          assertLive(actor)
          entryFor(request)
          effective.throwIfAborted()
          const execution = {
            session: { id: actor.sessionId ?? actor.sessionKey, cwd: actor.cwd },
            run: { id: actor.runId },
          }
          const payload =
            definition.kind === 'server'
              ? { operation: definition.name, input, context: { ...ctx, signal: undefined } }
              : definition.kind === 'hook'
                ? { name: definition.name, event: { ...(record(input) ? input : {}), ...execution } }
                : { name: definition.name, parameters: record(input) ? input.parameters : undefined, execution }
          const result = await runner.call(definition.kind, payload, effective)
          assertLive(actor)
          entryFor(request)
          effective.throwIfAborted()
          if (definition.kind === 'server')
            checkSchema((target as Omit<PluginOperation, 'execute'>).outputSchema, result, true)
          return checkedJson(result)
        })
      })
    })
  }

  const close = async (pluginId?: string, _force = false) => {
    const ids = pluginId
      ? [pluginId]
      : [...new Set([...metadata.keys(), ...tails.keys(), ...options.lease.agentEntries.map((item) => item.pluginId)])]
    for (const id of ids) {
      closeEpochs.set(id, (closeEpochs.get(id) ?? 0) + 1)
      metadata.delete(id)
    }
    const calls = [...active].filter((item) => !pluginId || item.pluginId === pluginId)
    for (const item of calls) item.controller.abort()
    await Promise.all(calls.map((item) => item.done))
  }
  return {
    close,
    isKnownTool(toolName: string): boolean {
      const actor = options.actor()
      for (const [pluginId, item] of metadata) {
        const entry = options.lease.agentEntries.find((candidate) => candidate.pluginId === pluginId)
        if (!entry?.grant || !options.manager.isGrantCurrent(pluginId, entry.generation, entry.grant.revision)) continue
        const key = JSON.stringify([
          entry.generation,
          entry.grant.policyHash,
          entry.grant.revision,
          actor.mode,
          actor.accessMode,
        ])
        if (item.key === key && item.visible.tools.some((tool) => tool.name === toolName)) return true
      }
      return false
    },
    async dispatch(request: PluginRuntimeRequest, signal: AbortSignal) {
      if (request.action === 'close') {
        await close(request.pluginId)
        return null
      }
      if (request.action !== 'initialize' && !name(request.name)) throw new Error('invalid-input: 插件操作名无效')
      if (request.action === 'hook' && ['sessionStart', 'sessionEnd'].includes(request.name!))
        throw new Error('permission-denied: 生命周期只由服务管理')
      const actor = snapshot()
      entryFor(request)
      signal.throwIfAborted()
      const epoch = closeEpochs.get(request.pluginId) ?? 0
      const next = (tails.get(request.pluginId) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          if ((closeEpochs.get(request.pluginId) ?? 0) !== epoch) throw new Error('scope-expired: 排队插件调用已失效')
          same(actor)
          if (request.action === 'initialize') return (await discover(request, actor, signal)).visible
          return execute(request, actor, signal)
        })
      tails.set(request.pluginId, next)
      try {
        return await next
      } finally {
        if (tails.get(request.pluginId) === next) tails.delete(request.pluginId)
      }
    },
  }
}
