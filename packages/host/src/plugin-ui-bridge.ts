import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PluginCallContext, PluginTarget, JsonValue } from '@pi-meme/plugin-sdk/rpc'
import { assertExecutionRequirements, type ExecutionCapabilityReport } from '@pi-meme/contracts/execution-capabilities'
import type { PluginHttpRequest } from '@pi-meme/plugin-sdk/restricted'
import type { PluginOperation } from '@pi-meme/plugin-sdk/server'
import type { PluginManager, RestrictedUiCall } from '@pi-meme/plugin-runtime/manager'
import { readPluginManifest } from '@pi-meme/plugin-runtime/package'
import { RestrictedRunner, type RestrictedRegistration } from '@pi-meme/plugin-runtime/restricted-runner'
import { authorizeOperation, checkSchema, checkedJson, validateOperation } from '@pi-meme/plugin-runtime/operation'
import { pluginSandboxLaunch } from './plugin-sandbox'
import type { PluginHttpBroker } from './plugin-http-broker'

export type PluginUiOperation = Omit<PluginOperation, 'execute'> & { kind: 'server' | 'http' | 'shared-data' }

export function createPluginUiBridge(options: {
  manager: () => PluginManager
  node: string
  runnerEntry?: string
  dataRoot: string
  sandboxCapability: { supported: boolean; reason?: string; report?: ExecutionCapabilityReport }
  http: PluginHttpBroker
  workspace: (target: PluginTarget) => Promise<string | undefined>
  executeOperation: (
    definition: PluginUiOperation,
    context: PluginCallContext,
    action: (signal: AbortSignal) => Promise<JsonValue>,
    input: JsonValue,
  ) => Promise<JsonValue>
}) {
  return async ({ descriptor, operation, input, context }: RestrictedUiCall): Promise<JsonValue> => {
    if (!options.sandboxCapability.supported)
      throw new Error(`sandbox-unavailable: ${options.sandboxCapability.reason ?? '平台未提供受限进程'}`)
    const report = options.sandboxCapability.report
    if (!report) throw new Error('sandbox-unavailable: 缺少受限插件能力报告')
    assertExecutionRequirements(report, [
      'host-secrets',
      'network-deny',
      'process-tree',
      'environment-isolation',
      'filesystem-write-boundary',
      'unix-socket-deny',
    ])
    const grant = descriptor.grant
    if (
      !grant ||
      !descriptor.policyHash ||
      context.origin !== 'ui' ||
      context.runtime !== 'restricted' ||
      descriptor.id !== context.pluginId ||
      descriptor.generation !== context.generation
    )
      throw new Error('permission-denied: UI 调用身份无效')
    let signal = AbortSignal.any([context.signal, AbortSignal.timeout(60000)])
    const current = () => {
      signal.throwIfAborted()
      const manager = options.manager()
      if (
        !manager.isGrantCurrent(descriptor.id, descriptor.generation, grant.revision) ||
        manager.getGeneration(descriptor.id, descriptor.generation)?.policyHash !== descriptor.policyHash
      )
        throw new Error('policy-changed: 插件代码或授权已改变')
    }
    current()
    const workspace = await options.workspace(context.target)
    current()
    const manifest = await readPluginManifest(descriptor.directory)
    if (!manifest.piMeme.server?.restricted) throw new Error('operation-unavailable-in-runtime: 无受限 Server')
    const scratch = await mkdtemp(path.join(tmpdir(), 'pi-plugin-ui-'))
    let runner: RestrictedRunner | undefined
    let registration: RestrictedRegistration | undefined
    let effect: string = 'read'
    const ctx: PluginCallContext = {
      ...context,
      signal,
      runtime: 'restricted',
      capabilities: (context.capabilities ?? []).filter((capability) =>
        grant.restricted.capabilities?.includes(capability),
      ),
      network: (context.network ?? []).flatMap((rule) => {
        const allowed = grant.restricted.network?.find((entry) => entry.id === rule.id && entry.origin === rule.origin)
        const methods = rule.methods.filter((method) => allowed?.methods.includes(method))
        return methods.length ? [{ ...rule, methods }] : []
      }),
      workspaceWritable: Boolean(
        workspace &&
        context.workspaceWritable === true &&
        grant.restricted.maxAccess === 'workspace-write' &&
        grant.restricted.capabilities?.includes('workspace.write'),
      ),
    }
    const start = async (writable: boolean) => {
      if (writable) assertExecutionRequirements(report, ['hardlink-write-boundary'])
      runner = new RestrictedRunner({
        node: options.node,
        entry: options.runnerEntry ?? RestrictedRunner.entry,
        directory: descriptor.directory,
        workspace: workspace ?? scratch,
        scratch,
        dataRoot: options.dataRoot,
        readable: Boolean(workspace && ctx.capabilities.includes('workspace.read')),
        writable,
        launch: pluginSandboxLaunch,
        initialize: {
          pluginId: descriptor.id,
          generation: descriptor.generation,
          server: path.join(descriptor.directory, manifest.piMeme.server!.restricted!),
        },
        broker: async (method, data, cancellation) => {
          current()
          if (method === 'http') {
            // 只读操作即使拥有广泛网络 grant，也不能借 broker 发出写请求。
            const scopedGrant = {
              ...grant,
              restricted: { ...grant.restricted, capabilities: ctx.capabilities, network: ctx.network },
            }
            const http = data as PluginHttpRequest
            const verb = String(http?.method ?? '').toUpperCase()
            const read = ['GET', 'HEAD'].includes(verb)
            if (!read && (effect !== 'external-write' || ctx.mode === 'plan' || ctx.accessMode === 'read-only'))
              throw new Error('permission-denied: 当前 Server 操作只允许只读网络方法')
            return options.executeOperation(
              {
                kind: 'http',
                name: 'httpRequest',
                audience: ['ui'],
                effect: read ? 'read' : 'external-write',
                capabilities: ['http.request'],
                inputSchema: {},
                outputSchema: {},
              },
              { ...ctx, requestId: crypto.randomUUID(), signal: cancellation },
              async (leaseSignal) => {
                current()
                const value = await options.http.request(
                  descriptor.id,
                  scopedGrant,
                  read || ctx.mode === 'plan' || ctx.accessMode === 'read-only' ? 'plan' : 'default',
                  http,
                  AbortSignal.any([signal, cancellation, leaseSignal]),
                )
                current()
                return checkedJson(value)
              },
              checkedJson(data),
            )
          }
          if (method === 'sharedData') {
            const key = typeof data === 'object' && data !== null && !Array.isArray(data) ? data.key : undefined
            if (
              typeof key !== 'string' ||
              !ctx.capabilities.includes('sharedData.read') ||
              !grant.restricted.sharedData?.includes(key)
            )
              throw new Error('permission-denied: 未授权共享数据')
            const scope = ctx.target.project?.projectId ?? ctx.target.session?.sessionId ?? ''
            return options.executeOperation(
              {
                kind: 'shared-data',
                name: 'sharedDataRead',
                audience: ['ui'],
                effect: 'read',
                capabilities: ['sharedData.read'],
                inputSchema: {},
                outputSchema: {},
              },
              { ...ctx, requestId: crypto.randomUUID(), signal: cancellation },
              async (leaseSignal) => {
                current()
                leaseSignal.throwIfAborted()
                return checkedJson(options.manager().readSharedData(descriptor.id, key, scope))
              },
              checkedJson(data),
            )
          }
          // UI Server 没有 Agent 生命周期或任意 Host RPC；不向包内代码透出 HostApi。
          throw new Error('permission-denied: UI Server 无此 broker 能力')
        },
      })
      const abort = () => {
        void runner?.close()
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        current()
        registration = await runner.start()
        current()
        checkedJson(registration, 1048576)
        if (!Array.isArray(registration.operations) || registration.operations.length > 128)
          throw new Error('invalid-output: Server 操作注册无效')
        const names = new Set<string>()
        for (const item of registration.operations) {
          validateOperation({ ...item, execute: async () => null } as PluginOperation)
          if (names.has(item.name)) throw new Error('invalid-output: Server 操作名称重复')
          names.add(item.name)
        }
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
    try {
      // 注册代码也只在只读 OS 边界运行；只有获准写操作才重新建立可写进程。
      await start(false)
      const selected = registration!.operations.find((item) => item.name === operation) as
        Omit<PluginOperation, 'execute'> | undefined
      if (!selected) throw new Error('operation-not-found: Server 未注册此操作')
      authorizeOperation(selected, ctx)
      checkSchema(selected.inputSchema, input)
      effect = selected.effect
      return await options.executeOperation(
        { ...selected, kind: 'server' },
        ctx,
        async (authorizedSignal) => {
          signal = AbortSignal.any([signal, authorizedSignal])
          ctx.signal = signal
          try {
            if (effect === 'workspace-write') {
              const definition = JSON.stringify(selected)
              await runner!.close()
              current()
              await start(true)
              const nextSelected = registration!.operations.find((item) => item.name === operation)
              if (!nextSelected || JSON.stringify(nextSelected) !== definition)
                throw new Error('policy-changed: Server 在权限切换后改变了操作定义')
              authorizeOperation(nextSelected as Omit<PluginOperation, 'execute'>, ctx)
            }
            const active = runner!
            const abort = () => {
              void active.close()
            }
            signal.addEventListener('abort', abort, { once: true })
            try {
              current()
              const result = await active.call(
                'server',
                { operation, input, context: { ...ctx, signal: undefined } },
                signal,
              )
              current()
              checkSchema(selected.outputSchema, result, true)
              return checkedJson(result)
            } finally {
              signal.removeEventListener('abort', abort)
            }
          } finally {
            await runner?.close()
          }
        },
        input,
      )
    } finally {
      await runner?.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
