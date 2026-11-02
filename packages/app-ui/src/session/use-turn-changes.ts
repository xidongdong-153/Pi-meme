import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { TurnChangeSummary } from '@pi-meme/contracts/turn-changes'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { ChatState } from '@pi-meme/chat/ui/model/types'

export function useTurnChanges(
  host: HostApi,
  session: SessionRef | undefined,
  chat: ChatState,
  enabled: boolean,
  onEvent: DesktopBridge['onEvent'],
  sessionKey?: string,
) {
  const owner = session ? `${session.hostId}:${session.sessionId}` : ''
  const ids = JSON.stringify(
    chat.messages.flatMap((message) =>
      message.role === 'user' && message.sourceEntry ? [message.sourceEntry.id] : [],
    ),
  )
  const [state, setState] = useState<{ owner: string; turns: TurnChangeSummary[] }>({ owner: '', turns: [] })
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const requests = useRef(new Map<string, Promise<void>>())
  const current = useRef(owner)
  current.current = owner
  useEffect(() => {
    if (!session || !enabled) return
    let disposed = false
    let inFlight = false
    let all = true
    const dirty = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const allIds = JSON.parse(ids) as string[]
    const refresh = async () => {
      if (disposed || inFlight || document.hidden) return
      inFlight = true
      let failed = false
      const previous = requests.current.get(owner)
      const task = (async () => {
        if (previous) await previous
        if (disposed || document.hidden) return
        const full = all
        all = false
        const entryIds = full ? allIds : [...dirty].filter((id) => allIds.includes(id))
        dirty.clear()
        try {
          const turns: TurnChangeSummary[] = []
          for (let index = 0; index < entryIds.length; index += 200)
            turns.push(...(await host.git.turnChangeSummaries(session, entryIds.slice(index, index + 200))))
          if (!disposed) {
            setState((previous) => {
              const next = {
                owner,
                turns:
                  full || previous.owner !== owner
                    ? turns
                    : [...previous.turns.filter((turn) => !entryIds.includes(turn.entryId)), ...turns],
              }
              return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
            })
            setError('')
          }
        } catch (cause) {
          failed = true
          all = true
          if (!disposed) setError(`读取本轮变更失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })()
      requests.current.set(owner, task)
      try {
        await task
      } finally {
        if (requests.current.get(owner) === task) requests.current.delete(owner)
        inFlight = false
        if (!disposed && ((!failed && all) || dirty.size)) schedule()
      }
    }
    function schedule() {
      if (disposed || timer || document.hidden || inFlight) return
      timer = setTimeout(() => {
        timer = undefined
        void refresh()
      }, 250)
    }
    const off = onEvent((value) => {
      if (value.sessionKey !== sessionKey) return
      const event = value.event
      if (event.type === 'turn_changes_update') dirty.add(event.entryId)
      else if (event.type === 'agent_settled') {
        const latest = allIds.at(-1)
        if (latest) dirty.add(latest)
      } else return
      schedule()
    })
    const visible = () => {
      if (!document.hidden) {
        all = true
        schedule()
      }
    }
    document.addEventListener('visibilitychange', visible)
    void refresh()
    return () => {
      disposed = true
      off()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [host, owner, session?.hostId, session?.sessionId, ids, enabled, revision, onEvent, sessionKey])

  const undo = useCallback(
    async (entryId: string) => {
      if (!session || current.current !== owner) throw new Error('会话已切换，请重新打开变更')
      await host.git.undoTurn(session, entryId, { idempotencyKey: crypto.randomUUID() })
      if (current.current === owner) {
        setState((previous) => ({
          ...previous,
          turns: previous.turns.map((turn) => (turn.entryId === entryId ? { ...turn, undone: true } : turn)),
        }))
        setRevision((value) => value + 1)
      }
    },
    [host, owner, session?.hostId, session?.sessionId],
  )
  return { turns: state.owner === owner ? state.turns : [], undo, error }
}
