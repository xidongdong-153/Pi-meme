import { useEffect, useRef, useState } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'

export function AgentPluginSelector({
  host,
  target,
  plugins,
  busy,
  onChanged,
  onSelection,
  onError,
}: {
  host: HostApi
  target?: SessionRef
  plugins: UiPluginDescriptor[]
  busy: boolean
  onChanged: () => Promise<unknown>
  onError: (error: string) => void
  onSelection: (plugins: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const hostId = target?.hostId
  const sessionId = target?.sessionId
  const currentTarget = useRef('')
  currentTarget.current = `${hostId}:${sessionId}`
  useEffect(() => {
    let current = true
    if (hostId && sessionId)
      void host.sessions
        .get({ hostId, sessionId })
        .then((session) => {
          if (current) {
            const ids = session.configuration.agentPlugins ?? []
            setSelected(ids)
            onSelection(ids)
          }
        })
        .catch((cause) => onError(String(cause)))
    else {
      setSelected([])
      onSelection([])
    }
    return () => {
      current = false
    }
  }, [host, hostId, sessionId, onError, onSelection])
  const agents = plugins.filter((plugin) => plugin.capabilities?.agent && plugin.enabled && plugin.status === 'active')
  if (!agents.length) return null
  async function configure(next: string[]) {
    if (!target || busy || saving) return
    const source = `${target.hostId}:${target.sessionId}`
    setSaving(true)
    try {
      await host.sessions.configure(target, { agentPlugins: next }, { idempotencyKey: crypto.randomUUID() })
      if (currentTarget.current === source) {
        setSelected(next)
        onSelection(next)
        await onChanged()
      }
    } catch (cause) {
      onError(String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <details className="px-3 py-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Agent 插件{selected.length ? ` · ${selected.length} 个` : ' · 未选择'}
      </summary>
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-muted-foreground">只在当前会话使用所选工具与消息能力。运行中不能修改。</p>
        {agents.map((plugin) => (
          <label key={plugin.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={busy || saving || !target}
              checked={selected.includes(plugin.id)}
              onChange={(event) =>
                void configure(
                  event.target.checked ? [...selected, plugin.id] : selected.filter((id) => id !== plugin.id),
                )
              }
            />
            {plugin.display?.name ?? plugin.id}
          </label>
        ))}
        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy || saving}
            onClick={() =>
              void host.plugins
                .setDefaultAgentPlugins(selected, { idempotencyKey: crypto.randomUUID() })
                .catch((cause) => onError(String(cause)))
            }
          >
            设为默认列表
          </button>
          <button
            type="button"
            disabled={busy || saving || !target}
            onClick={() =>
              void host.plugins
                .getDefaultAgentPlugins()
                .then((ids) => configure(ids.filter((id) => agents.some((plugin) => plugin.id === id))))
                .catch((cause) => onError(String(cause)))
            }
          >
            使用默认列表
          </button>
        </div>
      </div>
    </details>
  )
}
