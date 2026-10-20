import type { HostApi } from '@pi-meme/contracts/app-host'
import type { PluginConsentRequest } from './plugin-ui-consent'

const reads: Record<string, ReadonlySet<string>> = {
  plugins: new Set(['getDefaultAgentPlugins']),
  projects: new Set(['list', 'get']),
  sessions: new Set(['list', 'get', 'snapshot', 'history', 'message', 'messages', 'receipt', 'submissions']),
  files: new Set(['list', 'read', 'preview', 'search']),
  terminal: new Set(['attach']),
  git: new Set(['environment', 'snapshot', 'diff']),
  agents: new Set(['list', 'get']),
  goals: new Set(['get']),
  activities: new Set(['list', 'logs']),
  plans: new Set(['list']),
  events: new Set(['read', 'subscribe']),
}

/** 消息动作的写操作由宿主确认；这不是同源可信 UI 的安全沙箱。 */
export function createPluginActionHost(
  host: HostApi,
  pluginId: string,
  assertScope: () => void,
  confirm: (request: PluginConsentRequest) => Promise<boolean>,
  signal?: AbortSignal,
): HostApi {
  const assertActive = () => {
    if (signal?.aborted) throw new Error('cancelled：插件操作作用域已结束')
    assertScope()
  }
  const groups = new Map<string, object>()
  return new Proxy(host, {
    get(target, group: string) {
      const value: unknown = Reflect.get(target, group)
      if (typeof value === 'function')
        return (...args: unknown[]) => {
          assertActive()
          return Reflect.apply(value, target, args)
        }
      if (!value || typeof value !== 'object') return value
      const cached = groups.get(group)
      if (cached) return cached
      const proxy = new Proxy(value, {
        get(object, method: string) {
          const member: unknown = Reflect.get(object, method)
          if (typeof member !== 'function') return member
          return async (...args: unknown[]) => {
            assertActive()
            if (reads[group]?.has(method)) {
              const subscription = group === 'events' && method === 'subscribe'
              let stopped = false
              if (subscription && typeof args[1] === 'function') {
                const listener = args[1]
                args[1] = (event: unknown) => {
                  if (stopped) return
                  try {
                    assertActive()
                    Reflect.apply(listener, undefined, [structuredClone(event)])
                  } catch {
                    /* 退役或回调异常不打断宿主事件分发。 */
                  }
                }
              }
              const result: unknown = await Reflect.apply(member, object, args)
              try {
                assertActive()
              } catch (cause) {
                if (subscription && typeof result === 'function') {
                  stopped = true
                  Reflect.apply(result, undefined, [])
                }
                throw cause
              }
              if (subscription && typeof result === 'function') {
                const stop = () => {
                  if (stopped) return
                  stopped = true
                  signal?.removeEventListener('abort', stop)
                  Reflect.apply(result, undefined, [])
                }
                signal?.addEventListener('abort', stop, { once: true })
                if (signal?.aborted) stop()
                return stop
              }
              return result
            }
            const captured: unknown[] = structuredClone(args)
            const summary = JSON.stringify(captured)
            if (
              !(await confirm({
                pluginId,
                title: '允许插件执行此操作？',
                description: `${group}.${method}\n${summary.slice(0, 1600)}`,
                signal,
              }))
            )
              throw new Error('cancelled：用户取消了插件操作')
            assertActive()
            const result: unknown = await Reflect.apply(member, object, captured)
            assertActive()
            return result
          }
        },
      })
      groups.set(group, proxy)
      return proxy
    },
  })
}
