import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { McpExecutionBoundary } from './execution-boundary'
import { authorizeMcpHttpRequest, type McpHttpSource } from './http-request-authorization'
import type { McpAuthorizeOperation } from '@pi-meme/contracts/mcp-authorization'
import { mcpAuthorization } from '../shared/authorization'
import { guardMcpTransport } from './mcp-transport-guard'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  parseJsonRpcMessage,
  StreamableHttpTransport,
  type JsonRpcMessage,
  type McpTransport,
} from '@earendil-works/pi-mcp'
import type { McpTransportFactory, McpServerEntry } from '@earendil-works/pi-coding-agent'
import type { AccessSandboxOperations } from '@pi-meme/pi-runtime/sdk/access-sandbox'

function configValue(value: string) {
  if (value.startsWith('!')) throw new Error('Plan 中不执行 MCP 配置里的命令替换')
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    const result = process.env[key]
    if (result === undefined) throw new Error(`MCP 环境变量未配置：${key}`)
    return result
  })
}

function homePath(value: string) {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value
}

export function createPlanTransport(
  sandbox: () => AccessSandboxOperations,
  authorizedTools: (entry: McpServerEntry) => string[] | undefined,
  authorize?: McpAuthorizeOperation,
): McpTransportFactory {
  return createAuthorizedMcpTransport(sandbox, authorizedTools, true, authorize)
}

export function createAuthorizedMcpTransport(
  sandbox: () => AccessSandboxOperations,
  authorizedTools: (entry: McpServerEntry) => string[] | undefined,
  planning = false,
  authorize?: McpAuthorizeOperation,
  boundary?: McpExecutionBoundary,
  cachedToken?: (entry: McpServerEntry) => Promise<string | undefined>,
): McpTransportFactory {
  return (entry, cwd, authProvider) => {
    const config = entry.config
    const runtime = boundary ?? new McpExecutionBoundary()
    const ticket = runtime.capture()
    const permitted = () => {
      runtime.assert(ticket)
      return authorizedTools(entry)
    }
    const authority = {
      service: entry.name,
      configurationHash: mcpAuthorization(config),
      authorize,
      ...(boundary ? { beforeToolCall: () => boundary.claimToolCall() } : {}),
    }
    if ('url' in config) {
      if (config.auth?.provider)
        throw new Error('auth-refresh-unavailable: MCP 不共享模型 provider 凭据，请使用 MCP 专用授权')
      const requests = new AsyncLocalStorage<McpHttpSource>()
      const raw = new StreamableHttpTransport({
        url: config.url,
        authProvider: authProvider
          ? {
              token: () =>
                runtime.perform(ticket, async () => {
                  if (!cachedToken) throw new Error('auth-refresh-unavailable: 缺少 MCP 专用缓存 token 读取器')
                  const token = await cachedToken(entry)
                  runtime.assert(ticket)
                  return token
                }),
              onUnauthorized: async () => {
                throw new Error('auth-refresh-unavailable: OAuth refresh/login 尚无可取消的 Host 授权适配器')
              },
            }
          : undefined,
        headers: Object.fromEntries(
          Object.entries(config.headers ?? {}).map(([key, value]) => [key, configValue(value)]),
        ),
        maxMessageBytes: 4 * 1024 * 1024,
        fetch: (input, init) =>
          runtime.perform(ticket, async () => {
            const signal = init?.signal ? AbortSignal.any([ticket.signal, init.signal]) : ticket.signal
            signal.throwIfAborted()
            const allowed = authorizedTools(entry)
            if (!allowed || (planning && !allowed.length))
              throw new Error('permission-denied: MCP 服务授权已撤销或配置改变')
            const endpoint = new URL(config.url)
            const url = new URL(String(input))
            // Authentication endpoints are not silently admitted as readonly MCP protocol metadata.
            if (url.href !== endpoint.href || url.username || url.password)
              throw new Error('permission-denied: MCP HTTP 请求超出已签名 endpoint')
            const settled = await authorizeMcpHttpRequest(entry, authorize, url, init, requests.getStore(), signal)
            try {
              runtime.assert(ticket)
              signal.throwIfAborted()
              return await runtime.fetch(
                ticket,
                url,
                { ...init, signal, redirect: 'error', credentials: 'omit' },
                settled,
              )
            } catch (cause) {
              await settled?.(true)
              throw cause
            }
          }),
      })
      const transport: McpTransport = {
        start: () => runtime.perform(ticket, () => raw.start()),
        send: (message, options) =>
          runtime.perform(ticket, () => requests.run({ message, toolPosts: 0 }, () => raw.send(message, options))),
        close: () => requests.run({ toolPosts: 0, closing: true }, () => raw.close()),
        onMessage: (listener) => raw.onMessage(listener),
        onError: (listener) => raw.onError(listener),
        onClose: (listener) => raw.onClose(listener),
        setProtocolVersion: (version) => raw.setProtocolVersion(version),
      }
      return runtime.bind(guardMcpTransport(transport, permitted, planning, authority), ticket)
    }
    const messages = new Set<(message: JsonRpcMessage) => void>()
    const errors = new Set<(error: Error) => void>()
    const closes = new Set<() => void>()
    let process: Awaited<ReturnType<NonNullable<AccessSandboxOperations['startStdio']>>> | undefined
    let closed = false
    let starting: Promise<void> | undefined
    const transport: McpTransport = {
      start: () =>
        (starting ??= (async () => {
          const boundary = sandbox()
          if (!boundary.startStdio) throw new Error('sandbox-unavailable: 当前执行沙箱不支持 MCP stdio 进程')
          process = await boundary.startStdio(homePath(config.command), (config.args ?? []).map(homePath), {
            cwd: path.resolve(cwd, homePath(config.cwd ?? '.')),
            env: Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, configValue(value)])),
          })
          if (closed) {
            await process.stop()
            return
          }
          const decoder = new StringDecoder('utf8')
          let buffer = ''
          process.stdout.on('data', (chunk: Buffer) => {
            buffer += decoder.write(chunk)
            if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
              for (const listener of errors) listener(new Error('MCP 响应超过 16 MiB'))
              void transport.close()
              return
            }
            let end = buffer.indexOf('\n')
            while (end >= 0) {
              const line = buffer.slice(0, end).trim()
              buffer = buffer.slice(end + 1)
              end = buffer.indexOf('\n')
              if (!line) continue
              try {
                const message = parseJsonRpcMessage(JSON.parse(line))
                for (const listener of messages) listener(message)
              } catch (cause) {
                for (const listener of errors) listener(cause instanceof Error ? cause : new Error(String(cause)))
              }
            }
          })
          let stderr = ''
          process.stderr.on('data', (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096)
          })
          void process.completion
            .then(() => {
              if (!closed && stderr.trim())
                for (const listener of errors) listener(new Error(`MCP 进程退出：${stderr.trim()}`))
            })
            .catch((error: Error) => {
              for (const listener of errors) listener(error)
            })
            .finally(() => {
              if (!closed) {
                closed = true
                for (const listener of closes) listener()
              }
            })
        })()),
      send: async (message, options) => {
        await transport.start()
        if (closed || !process || options?.signal?.aborted) throw new Error('MCP 调用已取消或连接关闭')
        await new Promise<void>((resolve, reject) => {
          process!.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()))
        })
      },
      close: async () => {
        if (closed) return
        closed = true
        await starting?.catch(() => {})
        await process?.stop()
        for (const listener of closes) listener()
      },
      onMessage: (listener) => {
        messages.add(listener)
        return () => {
          messages.delete(listener)
        }
      },
      onError: (listener) => {
        errors.add(listener)
        return () => {
          errors.delete(listener)
        }
      },
      onClose: (listener) => {
        closes.add(listener)
        return () => {
          closes.delete(listener)
        }
      },
    }
    return runtime.bind(guardMcpTransport(transport, permitted, planning, authority), ticket)
  }
}
