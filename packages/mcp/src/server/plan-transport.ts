import { homedir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  parseJsonRpcMessage,
  StreamableHttpTransport,
  type JsonRpcMessage,
  type McpTransport,
} from '@earendil-works/pi-mcp'
import type { McpTransportFactory } from '@earendil-works/pi-coding-agent'
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

export function createPlanTransport(sandbox: () => AccessSandboxOperations): McpTransportFactory {
  return (entry, cwd, authProvider) => {
    if ('url' in entry.config) {
      return new StreamableHttpTransport({
        url: entry.config.url,
        authProvider,
        headers: Object.fromEntries(
          Object.entries(entry.config.headers ?? {}).map(([key, value]) => [key, configValue(value)]),
        ),
      })
    }
    const config = entry.config
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
          if (!boundary.startStdio) throw new Error('当前只读沙箱不支持 MCP 进程')
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
    return transport
  }
}
