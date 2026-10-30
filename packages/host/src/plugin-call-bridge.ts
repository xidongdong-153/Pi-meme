import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { SessionRef, ProjectRef } from '@pi-meme/contracts/app-host'
import type { PluginRuntimeRequest, RestrictedRegistration } from '@pi-meme/contracts/plugin-call'
import type { PluginCallContext, JsonValue } from '@pi-meme/plugin-sdk/rpc'
import type { PluginOperation } from '@pi-meme/plugin-sdk/server'
import type { PluginHttpRequest } from '@pi-meme/plugin-sdk/restricted'
import type { PluginGrant } from '@pi-meme/plugin-sdk/permissions'
import type { PluginLease, PluginManager } from '@pi-meme/plugin-runtime/manager'
import { RestrictedRunner } from '@pi-meme/plugin-runtime/restricted-runner'
import { authorizeOperation, checkSchema, checkedJson } from '@pi-meme/plugin-runtime/operation'
import { pluginSandboxLaunch } from './plugin-sandbox'
import type { PluginHttpBroker } from './plugin-http-broker'

export function allowedRestrictedContribution(
  value: { effect: string; capabilities: string[] },
  actor: Pick<AgentSummary, 'mode' | 'accessMode'>,
  grant: PluginGrant,
) {
  if (
    !['read', 'workspace-write', 'external-write', 'full-access'].includes(value.effect) ||
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

export function createPluginCallBridge(options: {
  lease: PluginLease
  manager: PluginManager
  actor: () => AgentSummary
  sessionRef: () => Promise<SessionRef & { project?: ProjectRef }>
  node: string
  runnerEntry?: string
  dataRoot: string
  sandboxCapability: { supported: boolean; reason?: string }
  http: PluginHttpBroker
  ui: (
    input: { pluginId: string; generation: number; method: string; input: unknown },
    signal: AbortSignal,
  ) => Promise<unknown>
}) {
  const instances = new Map<
    string,
    {
      runner: RestrictedRunner
      scratch: string
      registration: RestrictedRegistration
      mode: string
      access: string
      grantRevision: number
      runId?: string
      session: { id: string; cwd: string }
    }
  >()
  const tails = new Map<string, Promise<unknown>>()
  const assertLive = (actor: AgentSummary) => {
    if (!actor.runId || !['starting', 'running', 'waiting_input', 'waiting_children'].includes(actor.status))
      throw new Error('scope-expired: 没有有效执行 scope')
  }
  const same = (actor: AgentSummary) => {
    const current = options.actor()
    if (
      actor.epoch !== current.epoch ||
      actor.executionGeneration !== current.executionGeneration ||
      actor.runId !== current.runId ||
      actor.mode !== current.mode ||
      actor.accessMode !== current.accessMode
    )
      throw new Error('scope-expired: 插件执行已结束或权限变化')
    return current
  }
  const entryFor = (request: PluginRuntimeRequest) => {
    const entry = options.lease.agentEntries.find(
      (e) => e.pluginId === request.pluginId && e.generation === request.generation,
    )
    const current = options.manager.getGeneration(request.pluginId, request.generation)
    if (
      !entry ||
      !current?.enabled ||
      !entry.grant ||
      !options.manager.isGrantCurrent(request.pluginId, request.generation, entry.grant.revision)
    )
      throw new Error('policy-changed: 插件未选择、代次过期或授权变化')
    return entry
  }
  const context = async (
    request: PluginRuntimeRequest,
    actor: AgentSummary,
    signal: AbortSignal,
    trusted = false,
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
      runtime: trusted ? 'trusted' : 'restricted',
      workspaceWritable:
        actor.mode !== 'plan' &&
        actor.accessMode !== 'read-only' &&
        grant.restricted.maxAccess === 'workspace-write' &&
        grant.restricted.capabilities?.includes('workspace.write') === true,
      accessMode: actor.accessMode,
      capabilities: grant.restricted.capabilities ?? [],
      network: grant.restricted.network ?? [],
      signal,
      requestId: crypto.randomUUID(),
    }
  }
  const close = async (pluginId?: string, force = false) => {
    for (const [id, instance] of instances)
      if (!pluginId || pluginId === id) {
        instances.delete(id)
        try {
          if (!force)
            await instance.runner.call(
              'hook',
              { name: 'sessionEnd', event: { session: instance.session } },
              AbortSignal.timeout(1000),
            )
        } finally {
          await instance.runner.close()
          await rm(instance.scratch, { recursive: true, force: true })
        }
      }
  }
  const ensure = async (request: PluginRuntimeRequest) => {
    const actor = options.actor()
    const entry = entryFor(request)
    if (!options.sandboxCapability.supported)
      throw new Error(`sandbox-unavailable: ${options.sandboxCapability.reason ?? '受限进程探测失败'}`)
    const grant = entry.grant!
    const old = instances.get(request.pluginId)
    if (
      old &&
      old.mode === actor.mode &&
      old.access === actor.accessMode &&
      old.grantRevision === grant.revision &&
      old.runId === actor.runId
    )
      return old
    if (old) await close(request.pluginId)
    if (!entry.restricted || !entry.directory) throw new Error('operation-unavailable-in-runtime: 插件没有受限入口')
    const scratch = await mkdtemp(path.join(tmpdir(), 'pi-plugin-'))
    const runner: RestrictedRunner = new RestrictedRunner({
      node: options.node,
      entry: options.runnerEntry ?? RestrictedRunner.entry,
      workspace: actor.cwd,
      directory: entry.directory,
      scratch,
      dataRoot: options.dataRoot,
      readable: grant.restricted.capabilities?.includes('workspace.read') === true,
      writable:
        Boolean(actor.runId && ['starting', 'running', 'waiting_input', 'waiting_children'].includes(actor.status)) &&
        actor.mode !== 'plan' &&
        actor.accessMode !== 'read-only' &&
        grant.restricted.maxAccess === 'workspace-write' &&
        grant.restricted.capabilities?.includes('workspace.write') === true,
      launch: pluginSandboxLaunch,
      initialize: {
        pluginId: entry.pluginId,
        generation: entry.generation,
        agent: entry.restricted,
        server: entry.restrictedServer,
      },
      broker: async (method, input, signal): Promise<unknown> => {
        same(actor)
        entryFor(request)
        if (!['notify', 'status'].includes(method)) assertLive(options.actor())
        const data = input as Record<string, JsonValue>
        if (method === 'http')
          return options.http.request(entry.pluginId, grant, actor.mode, input as PluginHttpRequest, signal)
        if (method === 'sharedData') {
          if (
            !grant.restricted.capabilities?.includes('sharedData.read') ||
            !grant.restricted.sharedData?.includes(String(data.key))
          )
            throw new Error('permission-denied: 未授权共享记录')
          const ref = await options.sessionRef()
          same(actor)
          return options.manager.readSharedData(
            entry.pluginId,
            String(data.key),
            ref.project?.projectId ?? ref.sessionId,
          )
        }
        if (method === 'server') {
          const instance = instances.get(entry.pluginId)
          const operation = instance?.registration.operations.find((v) => v.name === data.operation)
          if (!operation) throw new Error('operation-unavailable-in-runtime: 受限 Server 无对应操作')
          const ctx = await context(request, actor, signal)
          authorizeOperation(operation as Omit<PluginOperation, 'execute'>, ctx)
          checkSchema(operation.inputSchema, data.input)
          const result = await runner.call(
            'server',
            { operation: data.operation, input: data.input, context: { ...ctx, signal: undefined } },
            signal,
          )
          checkSchema(operation.outputSchema, result, true)
          same(actor)
          return result
        }
        if (['interaction', 'notify', 'status', 'message'].includes(method)) {
          if (method === 'interaction' && !grant.restricted.capabilities?.includes('interaction.request'))
            throw new Error('permission-denied: 未授权提问')
          const value = await options.ui(
            { pluginId: entry.pluginId, generation: entry.generation, method, input },
            signal,
          )
          same(actor)
          return value
        }
        throw new Error('permission-denied: 未知受限 broker')
      },
    })
    try {
      const registered = await runner.start()
      entryFor(request)
      const allowed = (value: { effect: string; capabilities: string[] }) =>
        allowedRestrictedContribution(value, actor, grant)
      const registration = {
        ...registered,
        tools: registered.tools.filter(allowed),
        commands: registered.commands.filter(allowed),
      }
      if (
        registered.tools.length + registered.commands.length > 0 &&
        registration.tools.length + registration.commands.length === 0 &&
        !registered.hooks.length
      )
        throw new Error('grant-required: 已选择的插件在当前模式没有获准工具或命令')
      const value = {
        runner,
        scratch,
        registration,
        mode: actor.mode,
        access: actor.accessMode,
        grantRevision: grant.revision,
        runId: actor.runId,
        session: { id: actor.sessionId ?? actor.sessionKey, cwd: actor.cwd },
      }
      instances.set(request.pluginId, value)
      if (registered.hooks.includes('sessionStart'))
        await runner.call(
          'hook',
          { name: 'sessionStart', event: { session: { id: actor.sessionId ?? actor.sessionKey, cwd: actor.cwd } } },
          AbortSignal.timeout(1000),
        )
      return value
    } catch (cause) {
      await runner.close()
      await rm(scratch, { recursive: true, force: true })
      throw cause
    }
  }
  return {
    close,
    async dispatch(request: PluginRuntimeRequest, signal: AbortSignal) {
      if (request.action === 'close') {
        await close(request.pluginId)
        return null
      }
      const actor = options.actor()
      const entry = entryFor(request)
      if (request.action === 'hook' && ['sessionStart', 'sessionEnd'].includes(request.name ?? ''))
        throw new Error('permission-denied: 生命周期只由服务管理')
      if (request.action !== 'initialize') {
        assertLive(actor)
        signal.throwIfAborted()
      }
      if (
        request.action === 'server' &&
        actor.mode !== 'plan' &&
        actor.accessMode === 'full-access' &&
        entry.trusted &&
        entry.grant?.trusted.agent
      ) {
        if (!entry.grant.trusted.server) throw new Error('grant-required: 未信任 Server 入口')
        const result = await options.lease.callOperation(
          entry.pluginId,
          request.name!,
          checkedJson(request.input),
          await context(request, actor, signal, true),
        )
        same(actor)
        assertLive(options.actor())
        entryFor(request)
        return result
      }
      const instance = await ensure(request)
      same(actor)
      if (request.action === 'initialize') return instance.registration
      if (!actor.runId || signal.aborted) throw new Error('scope-expired: 没有有效运行')
      const execute = async () => {
        same(actor)
        if (request.action === 'tool' || request.action === 'command') {
          const item = (request.action === 'tool' ? instance.registration.tools : instance.registration.commands).find(
            (v) => v.name === request.name,
          )
          if (!item) throw new Error('permission-denied: 工具未授权')
          if (request.action === 'tool')
            checkSchema(
              (item as RestrictedRegistration['tools'][number]).parameters,
              (request.input as { parameters: unknown }).parameters,
            )
        }
        const execution = {
          session: { id: actor.sessionId ?? actor.sessionKey, cwd: actor.cwd },
          run: { id: actor.runId },
        }
        const input =
          request.action === 'hook'
            ? { name: request.name, event: { ...(request.input as object), ...execution } }
            : { name: request.name, ...(request.input as object), execution }
        const result = await instance.runner.call(request.action, input, signal)
        checkedJson(result)
        same(actor)
        return result
      }
      const tail = (tails.get(request.pluginId) ?? Promise.resolve()).catch(() => {}).then(execute)
      tails.set(request.pluginId, tail)
      return tail
    },
  }
}
