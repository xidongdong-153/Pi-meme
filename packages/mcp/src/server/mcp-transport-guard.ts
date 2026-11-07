import { randomUUID } from 'node:crypto'
import type { McpAuthorizationRequest, McpAuthorizeOperation } from '@pi-meme/contracts/mcp-authorization'
import type { JsonRpcMessage, McpTransport } from '@earendil-works/pi-mcp'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
const metadataMethods = new Set([
  'initialize',
  'ping',
  'tools/list',
  'notifications/initialized',
  'notifications/cancelled',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
])

type ActiveCall = {
  request: Extract<McpAuthorizationRequest, { phase: 'start' }>
  cleanup: () => void
  sent: boolean
  prepared: boolean
}

/** 远端注解只能成为候选：用户白名单、配置指纹和 Host 租约才是执行边界。 */
export function guardMcpTransport(
  inner: McpTransport,
  authorizedTools: () => string[] | undefined,
  readOnly: boolean,
  authority: {
    service: string
    configurationHash: string
    authorize?: McpAuthorizeOperation
    beforeToolCall?: () => void
  },
): McpTransport {
  const lists = new Set<string | number>()
  const candidates = new Set<string>()
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const pending = new Map<string | number, ActiveCall>()
  const finishing = new Set<Promise<void>>()
  const listeners = new Set<(message: JsonRpcMessage) => void>()
  const errors = new Set<(error: Error) => void>()
  let revocationTimer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const emitError = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    for (const listener of errors) listener(error)
  }
  const authorization = () => {
    const allowed = authorizedTools()
    if (!allowed || (readOnly && !allowed.length)) throw new Error('permission-denied: MCP 未授权，或服务配置已经变更')
    return allowed
  }
  const finish = async (id: string | number, failed: boolean) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.cleanup()
    const completion = authority.authorize!({ phase: 'finish', callId: entry.request.callId, failed })
    finishing.add(completion)
    try {
      await completion
    } finally {
      finishing.delete(completion)
    }
  }
  const finishAll = async () => {
    const calls = [...pending.keys()].map((id) => finish(id, true))
    const results = await Promise.allSettled([...calls, ...finishing])
    for (const result of results) if (result.status === 'rejected') emitError(result.reason)
  }
  const unsubscribeError = inner.onError(emitError)
  const unsubscribeClose = inner.onClose(() => {
    closed = true
    clearInterval(revocationTimer)
    void finishAll()
  })
  const receive = async (message: JsonRpcMessage) => {
    authorization()
    if (readOnly && 'method' in message && 'id' in message) {
      await inner.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: '只读模式不允许 MCP 服务端发起客户端请求' },
      })
      return
    }
    if ('method' in message && message.method === 'notifications/tools/list_changed') {
      candidates.clear()
      seen.clear()
      duplicates.clear()
    }
    if ('result' in message && lists.delete(message.id)) {
      const allowed = new Set(authorization())
      const result = message.result
      if (!record(result) || !Array.isArray(result.tools)) throw new Error('invalid-output: MCP 工具列表无效')
      for (const tool of result.tools) {
        if (!record(tool) || typeof tool.name !== 'string') continue
        if (seen.has(tool.name)) {
          duplicates.add(tool.name)
          candidates.delete(tool.name)
        }
        seen.add(tool.name)
      }
      const tools = result.tools.filter((tool) => {
        const candidate =
          record(tool) &&
          typeof tool.name === 'string' &&
          !duplicates.has(tool.name) &&
          record(tool.annotations) &&
          tool.annotations.readOnlyHint === true &&
          tool.annotations.destructiveHint !== true
        if (candidate) candidates.add(tool.name as string)
        return !readOnly || (candidate && allowed.has(tool.name as string))
      })
      if (readOnly) message = { ...message, result: { ...result, tools } } as JsonRpcMessage
    } else if ('error' in message) lists.delete(message.id)
    if ('id' in message && !('method' in message) && pending.has(message.id)) {
      if (!pending.get(message.id)!.sent) throw new Error('invalid-output: MCP 对尚未授权发送的工具伪造了响应')
      const failed =
        'error' in message || ('result' in message && record(message.result) && message.result.isError === true)
      try {
        await finish(message.id, failed)
      } catch (cause) {
        message = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(cause) } }
      }
      authorization()
    }
    for (const listener of listeners) listener(message)
  }
  const unsubscribe = inner.onMessage((message) => {
    void receive(message).catch((cause: unknown) => {
      emitError(cause)
      void close().catch(emitError)
    })
  })
  function close() {
    return (closing ??= (async () => {
      closed = true
      clearInterval(revocationTimer)
      unsubscribe()
      unsubscribeError()
      unsubscribeClose()
      const settled = await Promise.allSettled([inner.close(), finishAll()])
      lists.clear()
      candidates.clear()
      seen.clear()
      duplicates.clear()
      listeners.clear()
      errors.clear()
      const failure = settled.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })())
  }
  return {
    start: async () => {
      authorization()
      if (closed) throw new Error('scope-expired: MCP 连接已关闭')
      await inner.start()
      if (closed) throw new Error('scope-expired: MCP 连接已关闭')
      revocationTimer ??= setInterval(() => {
        try {
          authorization()
        } catch (cause) {
          emitError(cause)
          void close().catch(emitError)
        }
      }, 100)
      revocationTimer.unref()
    },
    send: async (message, options) => {
      const allowed = authorization()
      options?.signal?.throwIfAborted()
      if (closed) throw new Error('scope-expired: MCP 连接已关闭')
      if ('method' in message) {
        if (message.method === 'tools/call') {
          const params = message.params
          if (
            !('id' in message) ||
            !record(params) ||
            typeof params.name !== 'string' ||
            !params.name.length ||
            params.name.length > 256 ||
            pending.has(message.id) ||
            pending.size >= 64
          )
            throw new Error('invalid-input: MCP 工具调用无效或重复')
          if (readOnly && (!allowed.includes(params.name) || !candidates.has(params.name)))
            throw new Error('permission-denied: MCP 只读工具必须同时获得用户配置授权并明确声明只读')
          if (!authority.authorize) throw new Error('permission-denied: MCP 调用缺少 Host 授权桥')
          authority.beforeToolCall?.()
          const id = message.id
          const request: Extract<McpAuthorizationRequest, { phase: 'start' }> = {
            phase: 'start',
            callId: randomUUID(),
            serverName: authority.service,
            toolName: params.name,
            input: params.arguments ?? {},
            configHash: authority.configurationHash,
            annotatedReadOnly: candidates.has(params.name),
          }
          const aborted = () => {
            void finish(id, true).catch(emitError)
          }
          pending.set(id, {
            request,
            cleanup: () => options?.signal?.removeEventListener('abort', aborted),
            sent: false,
            prepared: false,
          })
          options?.signal?.addEventListener('abort', aborted, { once: true })
          try {
            await authority.authorize(request, options?.signal)
            const prepared = pending.get(id)
            if (prepared) prepared.prepared = true
            authorization()
            options?.signal?.throwIfAborted()
            if (!pending.has(id) || closed) throw new Error('scope-expired: MCP 调用已取消')
            pending.get(id)!.sent = true
            await inner.send(message, options)
          } catch (cause) {
            const entry = pending.get(id)
            if (entry && !entry.prepared) {
              pending.delete(id)
              entry.cleanup()
            } else await finish(id, true).catch(emitError)
            throw cause
          }
          return
        }
        if (!metadataMethods.has(message.method))
          throw new Error(`permission-denied: MCP 方法 ${message.method} 没有受支持的授权适配器`)
        if (message.method === 'tools/list' && 'id' in message) {
          if (!record(message.params) || !message.params.cursor) {
            candidates.clear()
            seen.clear()
            duplicates.clear()
          }
          lists.add(message.id)
        }
      }
      await inner.send(message, options)
    },
    close,
    onMessage: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onError: (listener) => {
      errors.add(listener)
      return () => {
        errors.delete(listener)
      }
    },
    onClose: (listener) => inner.onClose(listener),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
  }
}
