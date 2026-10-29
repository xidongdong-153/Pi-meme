import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'
import type { ChatState } from '@pi-meme/chat/ui/model/types'

export function useTurnChanges(host: HostApi, session: SessionRef | undefined, chat: ChatState, enabled: boolean) {
  const owner = session ? `${session.hostId}:${session.sessionId}` : ''
  const ids = JSON.stringify(
    chat.messages.flatMap((message) =>
      message.role === 'user' && message.sourceEntry ? [message.sourceEntry.id] : [],
    ),
  )
  const [state, setState] = useState<{ owner: string; turns: TurnChanges[] }>({ owner: '', turns: [] })
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const current = useRef(owner)
  current.current = owner
  useEffect(() => {
    if (!session || !enabled) return
    let disposed = false
    let inFlight = false
    const refresh = async (latestOnly = false) => {
      if (inFlight) return
      inFlight = true
      try {
        const allIds = JSON.parse(ids) as string[]
        const entryIds = latestOnly ? allIds.slice(-1) : allIds
        const turns: TurnChanges[] = []
        for (let index = 0; index < entryIds.length; index += 200)
          turns.push(...(await host.git.turnChanges(session, entryIds.slice(index, index + 200))))
        if (!disposed) {
          setState((previous) => ({
            owner,
            turns:
              latestOnly && previous.owner === owner
                ? [...previous.turns.filter((turn) => !entryIds.includes(turn.entryId)), ...turns]
                : turns,
          }))
          setError('')
        }
      } catch (cause) {
        if (!disposed) setError(`读取本轮变更失败：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = chat.running ? setInterval(() => void refresh(true), 750) : undefined
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [host, owner, session?.hostId, session?.sessionId, ids, chat.running, enabled, revision])

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
