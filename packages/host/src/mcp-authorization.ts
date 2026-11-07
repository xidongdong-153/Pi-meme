import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AuthorizationContext, AuthorizationOperation } from '@pi-meme/contracts/authorization'
import { mcpMetadataMethods, type McpAuthorizationRequest } from '@pi-meme/contracts/mcp-authorization'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { PiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { loadDesktopMcpConfig } from '@pi-meme/mcp/server/runtime-config'
import { mcpAuthorization } from '@pi-meme/mcp/shared/authorization'
import { checkedJson } from '@pi-meme/plugin-runtime/operation'
import type { HostAuthorization } from './authorization'

type PendingMcpCall = {
  controller: AbortController
  end: (failed: boolean) => void
  completion: Promise<void>
}

/** 每个真实 Worker 独占一个实例；context/cwd 只能由 Host 解析。 */
export function createMcpAuthorizationBridge(options: {
  authorization: HostAuthorization
  context: () => AuthorizationContext | Promise<AuthorizationContext>
  cwd: () => string | Promise<string>
  paths: PiRuntimePaths
  credentials: SecureCredentialStorage
}) {
  const pending = new Map<string, PendingMcpCall>()
  let disposed = false
  const validCallId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value)
  return {
    async dispatch(request: McpAuthorizationRequest, signal?: AbortSignal): Promise<void> {
      if (!request || !validCallId(request.callId)) throw new Error('invalid-input: MCP 调用标识无效')
      if (request.phase === 'finish') {
        if (typeof request.failed !== 'boolean') throw new Error('invalid-input: MCP 完成状态无效')
        const entry = pending.get(request.callId)
        if (!entry) throw new Error('scope-expired: MCP 调用租约不存在或已结束')
        entry.end(request.failed)
        if (request.failed) entry.controller.abort()
        try {
          await entry.completion
        } catch (cause) {
          if (!request.failed) throw cause
        }
        return
      }
      if (request.phase !== 'start' || disposed || pending.has(request.callId) || pending.size >= 64)
        throw new Error('scope-expired: MCP 调用重复、过多或 Worker 已关闭')
      if (
        typeof request.serverName !== 'string' ||
        !/^[\w-]{1,256}$/.test(request.serverName) ||
        typeof request.configHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.configHash) ||
        (request.kind === 'metadata'
          ? !(mcpMetadataMethods as readonly string[]).includes(request.method)
          : (request.kind !== undefined && request.kind !== 'tool') ||
            typeof request.toolName !== 'string' ||
            !request.toolName.length ||
            request.toolName.length > 256 ||
            typeof request.annotatedReadOnly !== 'boolean')
      )
        throw new Error('invalid-input: MCP 服务、工具或配置指纹无效')
      checkedJson(request.input, 1048576)
      const controller = new AbortController()
      let resolveAdmission!: () => void
      let rejectAdmission!: (cause: unknown) => void
      const admission = new Promise<void>((resolve, reject) => {
        resolveAdmission = resolve
        rejectAdmission = reject
      })
      let end!: (failed: boolean) => void
      const response = new Promise<void>((resolve, reject) => {
        end = (failed) => (failed ? reject(new Error('mcp-outcome-unknown: 调用失败或取消，远端效果未知')) : resolve())
      })
      // 响应可能在审批前被取消；提前挂上 rejection handler，最终仍由 execute 记录结果。
      void response.catch(() => {})
      const entry: PendingMcpCall = { controller, end, completion: Promise.resolve() }
      pending.set(request.callId, entry)
      const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const abort = () => {
        end(true)
        rejectAdmission(new Error('scope-expired: MCP 执行已取消'))
      }
      activeSignal.addEventListener('abort', abort, { once: true })
      entry.completion = (async () => {
        activeSignal.throwIfAborted()
        const cwd = await options.cwd()
        const initial = await options.context()
        const configured = () => {
          const server = loadDesktopMcpConfig(options.paths, cwd, options.credentials).servers.find(
            (item) => item.name === request.serverName,
          )
          if (!server || server.config.enabled === false || mcpAuthorization(server.config) !== request.configHash)
            throw new Error('policy-changed: MCP 服务配置或用户授权已经改变')
          return server
        }
        const server = configured()
        const planTools = (server.config as unknown as { planReadOnlyTools?: unknown }).planReadOnlyTools
        const metadata = request.kind === 'metadata'
        const explicitRead =
          metadata ||
          (request.annotatedReadOnly === true && Array.isArray(planTools) && planTools.includes(request.toolName))
        if ((initial.taskMode === 'plan' || initial.accessMode === 'read-only') && !explicitRead)
          throw new Error('permission-denied: MCP 只读调用必须获得当前配置白名单授权并有明确只读注解')
        const configuration = server.config
        const http = 'url' in configuration
        if (metadata) {
          if (!http || initial.principal.kind !== 'agent')
            throw new Error('permission-denied: MCP HTTP metadata 需要真实 Agent 主体')
          const input = request.input as Record<string, unknown>
          if (!input || typeof input !== 'object' || input.url !== new URL(configuration.url).href)
            throw new Error('permission-denied: MCP metadata endpoint 不属于 Host 签名服务')
          const method = request.method
          const message = input.message as Record<string, unknown> | undefined
          if (method === 'transport.http.get') {
            if (input.httpMethod !== 'GET' || message !== undefined)
              throw new Error('permission-denied: MCP GET metadata 无效')
          } else if (method === 'transport.http.delete') {
            if (input.httpMethod !== 'DELETE' || input.transportSessionCleanup !== true || message !== undefined)
              throw new Error('permission-denied: MCP DELETE 仅允许真实 session 清理')
          } else if (
            input.httpMethod !== 'POST' ||
            !message ||
            message.jsonrpc !== '2.0' ||
            (method === 'protocol.response'
              ? message.method !== undefined || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))
              : message.method !== method) ||
            message.method === 'tools/call'
          )
            throw new Error('permission-denied: MCP tools/call 或未知协议不能冒充 metadata')
        }
        let resource: string
        if (http) {
          const url = new URL(configuration.url)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('permission-denied: MCP 服务 endpoint 无效')
          resource = url.href
        } else {
          const configuredCwd = configuration.cwd ?? '.'
          const expanded =
            configuredCwd === '~'
              ? homedir()
              : configuredCwd.startsWith('~/')
                ? path.join(homedir(), configuredCwd.slice(2))
                : configuredCwd
          const effectiveCwd = await realpath(path.resolve(cwd, expanded))
          resource = `stdio:${configuration.command}\ncwd:${effectiveCwd}`
        }
        const operation: AuthorizationOperation = {
          id: metadata ? 'mcp.http.metadata' : 'mcp.tools.call',
          summary: `${request.serverName} / ${metadata ? request.method : request.toolName}`,
          effects: [
            {
              kind: explicitRead ? (http ? 'network.read' : 'process.read') : 'network.write',
              resource,
              boundary: http ? 'external' : 'workspace',
            },
          ],
          ...(http
            ? {}
            : { requiredCapabilities: ['host-secrets', 'network-deny', 'process-tree', 'environment-isolation'] }),
        }
        await options.authorization.execute(
          initial,
          operation,
          {
            serverName: request.serverName,
            ...(metadata ? { kind: 'metadata', method: request.method } : { toolName: request.toolName }),
            configHash: request.configHash,
            input: request.input,
          },
          `mcp:${request.callId}`,
          async (leaseSignal) => {
            const aborted = () => end(true)
            leaseSignal.addEventListener('abort', aborted, { once: true })
            try {
              leaseSignal.throwIfAborted()
              activeSignal.throwIfAborted()
              configured()
              resolveAdmission()
              await response
              leaseSignal.throwIfAborted()
              activeSignal.throwIfAborted()
              configured()
              const current = await options.context()
              if (
                current.principal.id !== initial.principal.id ||
                current.policyRevision !== initial.policyRevision ||
                current.taskMode !== initial.taskMode ||
                current.accessMode !== initial.accessMode ||
                ['hostId', 'projectId', 'sessionId', 'clientId'].some(
                  (key) =>
                    current.scope[key as keyof typeof current.scope] !==
                    initial.scope[key as keyof typeof initial.scope],
                )
              )
                throw new Error('scope-expired: MCP 结果不属于当前执行主体或策略')
            } finally {
              leaseSignal.removeEventListener('abort', aborted)
            }
          },
          activeSignal,
        )
      })()
        .catch((cause: unknown) => {
          rejectAdmission(cause)
          throw cause
        })
        .finally(() => {
          activeSignal.removeEventListener('abort', abort)
          if (pending.get(request.callId) === entry) pending.delete(request.callId)
        })
      void entry.completion.catch(() => {})
      await admission
    },
    async dispose() {
      disposed = true
      const active = [...pending.values()]
      for (const entry of active) {
        entry.controller.abort()
        entry.end(true)
      }
      await Promise.allSettled(active.map((entry) => entry.completion))
    },
  }
}
