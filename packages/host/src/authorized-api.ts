import type { AppSession, HostApi } from '@pi-meme/contracts/app-host'

export type AuthorizeHostApi = <T>(
  input: { clientId: string; method: string; args: unknown[]; session?: () => AppSession },
  action: () => Promise<T>,
) => Promise<T>

/** Wraps the statically assembled API, including direct internal calls and HTTP dispatch. */
export function authorizedHostApi(
  source: HostApi,
  clientId: string,
  authorize: AuthorizeHostApi,
  resolveSession: (args: unknown[]) => (() => AppSession) | undefined,
): HostApi {
  const wrap = (value: Record<string, unknown>, prefix = ''): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value).map(([name, member]) => {
        const method = prefix ? `${prefix}.${name}` : name
        if (typeof member === 'function') {
          if (method === 'events.subscribe')
            return [
              name,
              (...args: unknown[]) => {
                let active = true
                let dispose: (() => void) | undefined
                const stop = () => {
                  active = false
                  dispose?.()
                  dispose = undefined
                }
                void authorize({ clientId, method, args, session: resolveSession(args) }, async () => {
                  if (!active) return
                  const result: unknown = await Reflect.apply(member, value, args)
                  if (typeof result !== 'function') throw new Error('事件订阅未返回清理函数')
                  dispose = result as () => void
                  if (!active) stop()
                }).catch(stop)
                return stop
              },
            ]
          return [
            name,
            (...args: unknown[]) =>
              authorize({ clientId, method, args, session: resolveSession(args) }, async () =>
                Reflect.apply(member, value, args),
              ),
          ]
        }
        if (member && typeof member === 'object') return [name, wrap(member as Record<string, unknown>, method)]
        return [name, member]
      }),
    )
  return wrap(source as unknown as Record<string, unknown>) as unknown as HostApi
}
