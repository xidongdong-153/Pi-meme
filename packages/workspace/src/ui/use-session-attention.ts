import { useEffect, useRef } from 'react'
import type { WorkspaceBridge } from '@pi-meme/contracts/desktop'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type { SessionAttention, PiSessionsSnapshot } from '@pi-meme/contracts/sessions'

/** 仅确认当前正文已呈现的 Host 内容版本；未读状态始终取 Host 返回值。 */
export function useSessionAttention(
  snapshot: PiSessionsSnapshot | null,
  hostId: string,
  viewedPath: string | undefined,
  visible: boolean,
  running: boolean,
  {
    bridge,
    sessionId,
    messages,
    inputRequestIds,
    attention,
    connected,
    onAttention,
  }: {
    bridge: Pick<WorkspaceBridge, 'markSessionRead'>
    sessionId?: string
    messages: PiMessage[]
    inputRequestIds: string[]
    attention?: SessionAttention
    connected: boolean
    onAttention: (value: SessionAttention) => void
  },
) {
  const summary = viewedPath
    ? [
        ...(snapshot?.recents ?? []),
        ...(snapshot?.standaloneSessions ?? []),
        ...(snapshot?.projects.flatMap((project) => project.sessions) ?? []),
      ].find((entry) => entry.path === viewedPath)?.attention
    : undefined
  const matches = (value: SessionAttention | undefined) =>
    value?.session.hostId === hostId && value.session.sessionId === sessionId
  const current =
    matches(summary) && (!matches(attention) || summary!.revision >= attention!.revision)
      ? summary
      : matches(attention)
        ? attention
        : undefined
  const source = current?.completionSource
  const completionToken =
    !running &&
    current?.unread &&
    source &&
    messages.some(
      (message) => message.sourceEntry?.id === source.id && message.sourceEntry.revision === source.revision,
    )
      ? current.completionToken
      : undefined
  const observedInputs = current?.inputUnread
    ? [...new Set(inputRequestIds.filter((id) => current.inputRequestIds.includes(id)))].sort()
    : []
  const observation = JSON.stringify({ completionToken, inputRequestIds: observedInputs })
  const scope = JSON.stringify([hostId, sessionId])
  const attempts = useRef<{
    scope: string
    pending: Map<string, Promise<SessionAttention>>
    confirmed: Map<string, SessionAttention>
  }>({
    scope,
    pending: new Map(),
    confirmed: new Map(),
  })

  useEffect(() => {
    if (attempts.current.scope !== scope) attempts.current = { scope, pending: new Map(), confirmed: new Map() }
    if (!visible || !viewedPath || !connected || !hostId || !sessionId) return
    const observed = JSON.parse(observation) as { completionToken?: string; inputRequestIds: string[] }
    if (!observed.completionToken && !observed.inputRequestIds.length) return
    const state = attempts.current
    let active = true
    let waiting = false
    let notified = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    const mark = async () => {
      if (!active || waiting || notified || document.hidden || !document.hasFocus()) return
      waiting = true
      try {
        let result = state.confirmed.get(observation)
        if (!result) {
          let pending = state.pending.get(observation)
          if (!pending) {
            const request = bridge.markSessionRead({ hostId, sessionId }, observed).then((value) => {
              if (value.session.hostId !== hostId || value.session.sessionId !== sessionId)
                throw new Error('已读响应的会话身份不匹配')
              state.confirmed.set(observation, value)
              return value
            })
            pending = request.finally(() => {
              if (state.pending.get(observation) === pending) state.pending.delete(observation)
            })
            state.pending.set(observation, pending)
          }
          // effect 关闭不取消已发送业务；接替者等待同一请求，再接管成功通知或有限重试。
          result = await pending
        }
        if (active) {
          notified = true
          onAttention(result)
        }
      } catch {
        // 有限退避；失焦、切换或离开正文后取消，恢复焦点与重连可再次尝试。
        if (active && failures < 3 && !document.hidden && document.hasFocus()) {
          timer = setTimeout(() => void mark(), [1000, 3000, 10000][failures++])
        }
      } finally {
        waiting = false
      }
    }
    const resume = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (document.hidden || !document.hasFocus()) return
      failures = 0
      // 等待提交后的绘制机会，不能在正文尚未呈现时消费侧栏的新状态。
      frame = requestAnimationFrame(() => void mark())
    }
    resume()
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('blur', resume)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('blur', resume)
    }
  }, [bridge, connected, hostId, observation, onAttention, scope, sessionId, viewedPath, visible])

  return snapshot
}
