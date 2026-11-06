import { useCallback, useEffect, useState } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { GitAvailability } from '@pi-meme/contracts/git-availability'
import type { TurnChangeSummary } from '@pi-meme/contracts/turn-changes'
import type { PanelDataFact } from '../layout/panel-availability'

type State = {
  host: HostApi
  owner: string
  fact: PanelDataFact
  snapshot?: GitAvailability
}

const unknownFact: PanelDataFact = { status: 'unknown' }

function availabilityFact(value: GitAvailability): PanelDataFact {
  const workspace = value.workspace
  const turns = value.turns
  if (
    (workspace.status === 'ready' && (workspace.hasStaged || workspace.hasUnstaged || workspace.hasUntracked)) ||
    (turns.status === 'ready' && turns.hasChanges)
  )
    return { status: 'ready', value: true, revision: value.revision }
  if (workspace.status === 'ready' && turns.status === 'ready')
    return { status: 'ready', value: false, revision: value.revision }
  const failures = [workspace, turns].filter((source) => source.status !== 'ready')
  return {
    status: failures.some((source) => source.status === 'error') ? 'error' : 'unsupported',
    error: failures
      .map((source) => ('error' in source ? source.error : undefined))
      .filter(Boolean)
      .join('；'),
    revision: value.revision,
  }
}

/** 目录只查询存在性；内容面板仍按自己的可见性加载完整差异。 */
export function useGitAvailability({
  host,
  session,
  enabled,
  revision,
  targetKey,
  onEvent,
  sessionKey,
  knownTurns,
}: {
  host: HostApi
  session?: SessionRef
  enabled: boolean
  revision: string
  targetKey: string
  onEvent: DesktopBridge['onEvent']
  sessionKey?: string
  knownTurns: readonly TurnChangeSummary[]
}) {
  const owner = session ? JSON.stringify([session.hostId, session.sessionId, sessionKey, targetKey]) : ''
  const [state, setState] = useState<State>()
  const [retryRevision, setRetryRevision] = useState(0)
  const retry = useCallback(() => setRetryRevision((value) => value + 1), [])
  const knownTurn = knownTurns.findLast((turn) => turn.files.length > 0)
  const knownTurnId = knownTurn?.entryId
  const knownTurnRevision = knownTurn?.revision

  useEffect(() => {
    if (!enabled || !session) return
    let stopped = false
    let pending = false
    let dirty = false
    let epoch = 0
    let support: boolean | undefined
    let release: (() => void) | undefined
    const currentSession = session
    const publish = (fact: PanelDataFact, snapshot?: GitAvailability) => {
      if (stopped) return
      setState((previous) => {
        const retained = previous?.host === host && previous.owner === owner ? previous : undefined
        const nextFact = fact.status === 'ready' ? fact : { ...fact, value: retained?.fact.value }
        const next = { host, owner, fact: nextFact, snapshot: snapshot ?? retained?.snapshot }
        return retained &&
          JSON.stringify(retained.fact) === JSON.stringify(next.fact) &&
          JSON.stringify(retained.snapshot) === JSON.stringify(next.snapshot)
          ? retained
          : next
      })
    }
    const refresh = async () => {
      if (stopped || document.hidden) return
      if (pending) {
        dirty = true
        return
      }
      pending = true
      const requestEpoch = epoch
      try {
        if (support === undefined) support = (await host.capabilities()).features.includes('git-availability')
        if (stopped || requestEpoch !== epoch) return
        if (support && host.git.availability) {
          const snapshot = await host.git.availability(currentSession)
          if (!stopped && requestEpoch === epoch && snapshot.sessionId === currentSession.sessionId)
            publish(availabilityFact(snapshot), snapshot)
        } else {
          // 旧 Host 的分页轮次只能证明“有”，不能证明完整历史为空。
          const snapshot = await host.git.snapshot(currentSession)
          if (stopped || requestEpoch !== epoch) return
          if (snapshot.error && snapshot.error !== 'not-repository' && snapshot.error !== 'unavailable')
            throw new Error(snapshot.error)
          const staged = snapshot.files.some((file) => file.kind === 'staged')
          const untracked = snapshot.files.some((file) => file.kind === 'untracked')
          const unstaged = snapshot.files.some((file) => file.kind === 'unstaged')
          const hasChanges = staged || untracked || unstaged || Boolean(knownTurnId)
          const legacy: GitAvailability = {
            sessionId: currentSession.sessionId,
            revision: JSON.stringify([staged, unstaged, untracked, knownTurnId, knownTurnRevision]),
            workspace: {
              status: 'ready',
              root: snapshot.root,
              hasStaged: staged,
              hasUnstaged: unstaged,
              hasUntracked: untracked,
            },
            turns: knownTurnId
              ? { status: 'ready', hasChanges: true, entryId: knownTurnId }
              : { status: 'unsupported' },
            suggestedOpen:
              unstaged || untracked
                ? { scope: 'unstaged' }
                : staged
                  ? { scope: 'staged' }
                  : knownTurnId
                    ? { scope: 'turn', entryId: knownTurnId }
                    : undefined,
          }
          publish(
            hasChanges ? { status: 'ready', value: true, revision: legacy.revision } : { status: 'unsupported' },
            legacy,
          )
        }
      } catch (cause) {
        if (!stopped && requestEpoch === epoch)
          publish({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        pending = false
        if (dirty && !stopped) {
          dirty = false
          void refresh()
        }
      }
    }
    const invalidate = () => {
      epoch++
      void refresh()
    }
    const off = onEvent((record) => {
      if (record.sessionKey !== sessionKey) return
      if (record.event.type === 'turn_changes_update' || record.event.type === 'agent_settled') invalidate()
    })
    void host.events
      .subscribe({ sessionId: currentSession.sessionId }, (event) => {
        if (event.type === 'resync') invalidate()
      })
      .then((unsubscribe) => {
        if (stopped) unsubscribe()
        else {
          release = unsubscribe
          invalidate()
        }
      })
      .catch((cause) => {
        if (!stopped) publish({ status: 'error', error: String(cause) })
      })
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    const resume = () => {
      if (!document.hidden) invalidate()
    }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true
      epoch++
      clearInterval(timer)
      off()
      release?.()
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [
    host,
    owner,
    enabled,
    revision,
    session?.hostId,
    session?.sessionId,
    onEvent,
    sessionKey,
    retryRevision,
    knownTurnId,
    knownTurnRevision,
  ])

  const current = state?.host === host && state.owner === owner ? state : undefined
  return { fact: current?.fact ?? unknownFact, snapshot: current?.snapshot, retry }
}
