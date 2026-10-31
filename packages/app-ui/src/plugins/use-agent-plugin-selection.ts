import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSession, HostApi } from '@pi-meme/contracts/app-host'
import type { ResourceCatalog } from '@pi-meme/contracts/resources'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import type { AgentPluginOption, ComposerAgentPlugins } from '@pi-meme/chat/ui/composer/composer'

const emptyIds: string[] = []

function sameSession(left: { host: HostApi; session?: AppSession }, right: { host: HostApi; session?: AppSession }) {
  return Boolean(
    left.session &&
    right.session &&
    left.host === right.host &&
    left.session.hostId === right.session.hostId &&
    left.session.sessionId === right.session.sessionId,
  )
}

export function useAgentPluginSelection({
  host,
  session,
  plugins,
  resources,
  cwd,
  pluginMentions,
  onPluginMentions,
  busy,
  onChanged,
  onError,
}: {
  host: HostApi
  session?: AppSession
  plugins: UiPluginDescriptor[]
  resources: ResourceClient
  cwd?: string
  pluginMentions: string[]
  onPluginMentions: (ids: string[]) => void
  busy: boolean
  onChanged: () => Promise<unknown>
  onError: (error: string) => void
}): ComposerAgentPlugins & { ids: string[] } {
  const context = useMemo(() => ({ host, session }), [host, session])
  const current = useRef(context)
  current.current = context
  const pending = useRef(new Set<typeof context>())
  const [selection, setSelection] = useState<{ context: typeof context; ids: string[]; saving: boolean }>()
  const [catalog, setCatalog] = useState<{ context: typeof context; value?: ResourceCatalog; error?: string }>()
  const ids = selection?.context === context ? selection.ids : (session?.configuration.agentPlugins ?? emptyIds)
  const saving = Boolean(
    (selection?.context === context && selection.saving) ||
    [...pending.current].some((source) => sameSession(source, context)),
  )
  const loading = Boolean(session && (catalog?.context !== context || (!catalog.value && !catalog.error)))

  useEffect(() => {
    if (!session) return
    let cancelled = false
    let revision = 0
    const refresh = () => {
      const request = ++revision
      void resources.catalog(cwd).then(
        (value) => {
          if (!cancelled && request === revision) setCatalog({ context, value })
        },
        (cause: unknown) => {
          if (!cancelled && request === revision) {
            const error = `无法读取 Agent 插件：${String(cause)}`
            setCatalog({ context, error })
            onError(error)
          }
        },
      )
    }
    refresh()
    const dispose = resources.onChange(refresh)
    return () => {
      cancelled = true
      dispose()
    }
  }, [context, session, resources, cwd, plugins, onError])

  const entries = useMemo(
    () =>
      new Map<string, AgentPluginOption>(
        plugins.map((plugin) => [
          plugin.id,
          {
            id: plugin.id,
            name: plugin.display?.name ?? plugin.id,
            description: plugin.description,
            iconUrl: plugin.iconUrl,
          },
        ]),
      ),
    [plugins],
  )
  const options = useMemo(
    () =>
      plugins
        .filter(
          (plugin) =>
            plugin.capabilities?.agent &&
            plugin.enabled &&
            plugin.status === 'active' &&
            catalog?.context === context &&
            catalog.value?.items.some(
              (item) => item.kind === 'app-plugin' && item.owner.id === plugin.id && item.enabled,
            ),
        )
        .map((plugin) => entries.get(plugin.id)!),
    [plugins, catalog, context, entries],
  )
  const selected = useMemo(() => ids.map((id) => entries.get(id) ?? { id, name: id }), [ids, entries])
  const disabledReason = !session
    ? '正在准备会话'
    : saving
      ? '正在保存插件选择'
      : busy
        ? '任务结束后可修改插件'
        : loading
          ? '正在读取插件列表'
          : catalog?.context === context
            ? catalog.error
            : undefined

  const change = useCallback(
    async (requested: string[]) => {
      if (
        !session ||
        disabledReason ||
        current.current !== context ||
        [...pending.current].some((source) => sameSession(source, context))
      )
        return false
      const next = [...new Set(requested)]
      if (next.some((id) => !ids.includes(id) && !options.some((plugin) => plugin.id === id))) {
        onError('Agent 插件已不可用，请重新选择')
        return false
      }
      if (next.length === ids.length && next.every((id, index) => id === ids[index])) return true
      pending.current.add(context)
      setSelection({ context, ids, saving: true })
      try {
        const result = await host.sessions.configure(
          { hostId: session.hostId, sessionId: session.sessionId },
          { agentPlugins: next },
          { idempotencyKey: crypto.randomUUID() },
        )
        if (current.current !== context) return false
        const savedIds = result.configuration.agentPlugins ?? emptyIds
        setSelection({ context, ids: savedIds, saving: true })
        onPluginMentions(pluginMentions.filter((id) => savedIds.includes(id)))
        try {
          await onChanged()
        } catch (cause) {
          if (current.current === context) onError(`插件选择已保存，无法刷新会话：${String(cause)}`)
        }
        return current.current === context
      } catch (cause) {
        if (current.current === context) onError(`无法修改 Agent 插件：${String(cause)}`)
        return false
      } finally {
        pending.current.delete(context)
        const latest = current.current
        if (latest === context)
          setSelection((value) => (value?.context === context ? { ...value, saving: false } : value))
        else if (sameSession(latest, context)) {
          try {
            const restored = await host.sessions.get({ hostId: session.hostId, sessionId: session.sessionId })
            if (current.current === latest && ![...pending.current].some((source) => sameSession(source, latest))) {
              setSelection({ context: latest, ids: restored.configuration.agentPlugins ?? emptyIds, saving: false })
              await onChanged()
            }
          } catch (cause) {
            if (current.current === latest) onError(`无法刷新会话插件：${String(cause)}`)
          }
        }
      }
    },
    [context, session, disabledReason, ids, options, host, onChanged, onError, pluginMentions, onPluginMentions],
  )

  const select = async (id: string) => {
    if (disabledReason || current.current !== context) return false
    const success = ids.includes(id) || (await change([...ids, id]))
    if (success && current.current === context) onPluginMentions([...new Set([...pluginMentions, id])])
    return success
  }
  const mentions = useMemo(
    () =>
      pluginMentions.map((id) => selected.find((plugin) => plugin.id === id) ?? entries.get(id) ?? { id, name: id }),
    [selected, pluginMentions, entries],
  )
  return { ids, options, selected, mentions, select, loading, saving, disabledReason, change }
}
