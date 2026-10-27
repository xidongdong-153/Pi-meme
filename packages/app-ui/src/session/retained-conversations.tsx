import { Activity, useId, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react'
import { Conversation } from '@pi-meme/chat/ui/conversation/conversation'
import type { ChatState } from '@pi-meme/chat/ui/model/types'

type Props = ComponentProps<typeof Conversation>
type Pane = { owner: string; key: string }
let order: Pane[] = []
const listeners = new Set<() => void>()
const snapshot = () => order
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function publish() {
  for (const listener of listeners) listener()
}

/** 三个面板共享一个输入框和会话订阅；Activity 隐藏时清理计时器与订阅副作用。 */
export function RetainedConversations({
  hostId,
  active,
  getCachedChat,
  ...props
}: Props & {
  hostId: string
  active: boolean
  getCachedChat: (key: string) => ChatState | undefined
}) {
  const owner = useId()
  const panes = useRef(new Map<string, Props>())
  const retained = useSyncExternalStore(subscribe, snapshot, snapshot)
  const key = props.sessionKey ? `${hostId}:${props.sessionKey}` : `${hostId}:empty`
  const previous = useRef(key)
  if (previous.current !== key) {
    const old = panes.current.get(previous.current)
    if (old)
      panes.current.set(previous.current, {
        ...old,
        chat: old.sessionKey ? (getCachedChat(old.sessionKey) ?? old.chat) : old.chat,
        stream: undefined,
        editor: undefined,
        canEditMessages: false,
        canForkReplies: false,
      })
    previous.current = key
  }
  panes.current.set(key, props)
  useLayoutEffect(() => {
    if (!active) return
    if (order[0]?.owner === owner && order[0].key === key) return
    order = [{ owner, key }, ...order.filter((pane) => pane.owner !== owner || pane.key !== key)].slice(0, 3)
    publish()
  }, [owner, key, active])
  useLayoutEffect(
    () => () => {
      order = order.filter((pane) => pane.owner !== owner)
      publish()
    },
    [owner],
  )
  const held = retained
    .filter(
      (pane) =>
        pane.owner === owner &&
        (pane.key === key ||
          Boolean(panes.current.get(pane.key)?.sessionKey && getCachedChat(panes.current.get(pane.key)!.sessionKey!))),
    )
    .map((pane) => pane.key)
  const keys = active ? [key, ...held.filter((id) => id !== key)].slice(0, 3) : held
  for (const id of panes.current.keys()) if (!keys.includes(id)) panes.current.delete(id)
  return (
    <>
      {keys.map((id) => {
        const pane = panes.current.get(id)
        return pane ? (
          <Activity key={id} mode={active && id === key ? 'visible' : 'hidden'}>
            <div className="flex flex-1 min-h-0 min-w-0 flex-col" data-session-pane={id}>
              <Conversation {...pane} />
            </div>
          </Activity>
        ) : null
      })}
    </>
  )
}
