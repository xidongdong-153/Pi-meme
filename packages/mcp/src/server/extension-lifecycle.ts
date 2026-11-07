import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { RegisterExecutionBoundary } from '@pi-meme/contracts/execution-boundary'
import type { McpExecutionBoundary } from './execution-boundary'

type Handler = (...args: unknown[]) => unknown
type Command = Parameters<ExtensionAPI['registerCommand']>[1]

/** Keep SDK connection objects reusable; only their concrete transports are replaced. */
export function createMcpExtensionLifecycle(
  pi: ExtensionAPI,
  boundary: McpExecutionBoundary,
  register: RegisterExecutionBoundary | undefined,
  localServers: (context: ExtensionContext) => string[],
) {
  let sessionStart: { handler: Handler; args: unknown[] } | undefined
  let registryChange: { handler: Handler; args: unknown[] } | undefined
  let initialized = false
  let needsReconnect = false
  let loading: Promise<void> | undefined
  let command: Command | undefined
  const unsubscribe = register?.(async (reason, paused) => {
    if (reason === 'resume' && !paused) await boundary.resume()
    else {
      needsReconnect = true
      await boundary.cancel(reason, paused)
    }
  })
  // Register per factory, not per Worker create(): a new SDK factory gets a fresh listener after reconnect.
  pi.on('agent_end', async () => {
    needsReconnect = true
    await boundary.cancel('agent_end', false)
  })
  const ready = async (context: ExtensionContext) => {
    boundary.capture()
    if (loading) {
      await loading.catch(() => {})
      boundary.capture()
    }
    if (initialized && !needsReconnect && !registryChange) return
    const work = boundary.invoke(async () => {
      if (!initialized && sessionStart) {
        const start = sessionStart
        await start.handler(start.args[0], context)
        boundary.capture()
        initialized = true
        needsReconnect = false
      }
      if (registryChange) {
        const change = registryChange
        registryChange = undefined
        await change.handler(change.args[0], context)
        boundary.capture()
      }
      if (needsReconnect && command) {
        needsReconnect = false
        for (const name of localServers(context)) {
          boundary.capture()
          // The SDK public reconnect operation awaits its old opening promise, then reuses the connection.
          await command.handler(`reconnect ${name}`, context as Parameters<Command['handler']>[1])
        }
      }
    })
    loading = work
    try {
      await work
    } finally {
      if (loading === work) loading = undefined
    }
  }
  const api = new Proxy(pi, {
    get(target, key, receiver) {
      if (key === 'on')
        return (name: string, handler: Handler) =>
          Reflect.apply(target.on, target, [
            name,
            async (...args: unknown[]) => {
              if (name === 'session_start') {
                sessionStart = { handler, args }
                localServers(args[1] as ExtensionContext) // Local configuration only: no ownerless startup HTTP.
                return
              }
              if (name === 'session_shutdown') {
                try {
                  await boundary.dispose()
                  return await handler(...args)
                } finally {
                  unsubscribe?.()
                }
              }
              if (name === 'mcp_servers_change') {
                registryChange = { handler, args }
                return
              }
              if (name === 'before_agent_start') {
                await boundary.agentStart()
                return boundary.invoke(async () => {
                  await ready(args[1] as ExtensionContext)
                  return handler(...args)
                })
              }
              return boundary.invoke(() => handler(...args))
            },
          ])
      if (key === 'registerCommand')
        return (name: string, definition: Command) => {
          if (name === 'mcp') command = definition
          target.registerCommand(name, {
            ...definition,
            handler: (args, context) =>
              boundary.invoke(async () => {
                const action = args.trim().split(/\s+/)[0]
                if (name === 'mcp' && ((action && action !== 'reconnect') || (!action && context.mode === 'tui')))
                  throw new Error('auth-refresh-unavailable: MCP 交互登录/凭据管理需要独立可取消的 Host 适配器')
                await ready(context)
                return definition.handler(args, context)
              }),
          })
        }
      return Reflect.get(target, key, receiver)
    },
  }) as ExtensionAPI
  return { api, ready }
}
