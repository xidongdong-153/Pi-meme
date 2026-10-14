import type { ChatStream } from '../model/chat-stream'
import * as React from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatState, ConversationOutlineEntry, TurnChunk } from '../model/types'
import { ChatMessage } from './chat-message'
import { AssistantTurnView } from './assistant-turn'
import { InlineMessageEditor, type MessageEditorState } from './inline-message-editor'
import { groupConversationTurns } from '../model/conversation-turns'
import { projectMainConversation } from '../model/conversation-projection'
import { useConversationScroll } from './use-conversation-scroll'
import { Button } from '@pi-meme/ui/components/ui/button'
import { messageVersions } from '../model/message-versions'
import { CompactionCard, CompactionProgressCard } from './compaction-card'
import { conversationOutline } from '../model/conversation-outline'
import { ConversationOutline } from './conversation-outline'
import { PluginMessage } from '@pi-meme/ui/components/plugin-message'
import { messageText } from '../model/message-text'
import { AgentStatusRow } from './agent-status-row'
import { ErrorLine } from '@pi-meme/ui/components/error-line'

function noSubscription() {
  return () => {}
}

const INITIAL_VISIBLE_TURNS = 30
const TURN_INCREMENT = 30

export const Conversation = React.memo(
  ({
    chat: initialChat,
    stream,
    canEditMessages,
    onEditMessage,
    onSwitchMessageVersion,
    onForkReply,
    onCopyError,
    editor,
    switchingVersion,
    readOnly = false,
  }: {
    chat: ChatState
    stream?: ChatStream
    canEditMessages: boolean
    onEditMessage: (message: Extract<TurnChunk, { type: 'user' }>['message']) => void
    onSwitchMessageVersion: (timestamp: number, version: number) => void
    onForkReply: (timestamp: number) => void
    onCopyError: (message: string) => void
    /** 正在原位置编辑的用户消息，命中该时间戳时用编辑器替换消息气泡。 */
    editor?: MessageEditorState
    /** 正在切换版本的原始消息时间戳，用于展示切换进度。 */
    switchingVersion?: number
    readOnly?: boolean
  }) => {
    const chat = React.useSyncExternalStore(
      stream?.subscribe ?? noSubscription,
      stream?.getSnapshot ?? (() => initialChat),
      stream?.getSnapshot ?? (() => initialChat),
    )
    const { containerRef, bottomRef, showScrollBottom, handleScroll, scrollToBottom, scrollToMessage } =
      useConversationScroll(chat)

    // 按对话轮次（Turn）聚合消息流：将同一交互轮次内的思考、多次工具调用、Bash 与最终正文聚合成单一轮次卡片
    const turns = React.useMemo(() => {
      const view = readOnly ? chat : projectMainConversation(chat)
      return groupConversationTurns(
        view.messages,
        view.live,
        view.tools,
        chat.running,
        chat.stream.completed,
        'agentStatuses' in view ? view.agentStatuses : [],
        chat.runIntervals,
      )
    }, [chat, readOnly])
    const outline = React.useMemo(() => conversationOutline(turns), [turns])

    const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_TURNS)
    const [pinnedStartKey, setPinnedStartKey] = React.useState<string>()
    const [activeKey, setActiveKey] = React.useState<string>()
    const [pendingKey, setPendingKey] = React.useState<string>()
    const userMessageRefs = React.useRef(new Map<string, HTMLDivElement>())
    const firstTurnKey = turns[0]?.key
    const prevFirstKeyRef = React.useRef(firstTurnKey)

    // 切换会话时重置窗口大小
    React.useEffect(() => {
      if (prevFirstKeyRef.current !== firstTurnKey) {
        prevFirstKeyRef.current = firstTurnKey
        setVisibleCount(INITIAL_VISIBLE_TURNS)
        setPinnedStartKey(undefined)
        setPendingKey(undefined)
      }
    }, [firstTurnKey])

    const pinnedStart = pinnedStartKey ? turns.findIndex((turn) => turn.key === pinnedStartKey) : -1
    const windowStart = Math.min(Math.max(0, turns.length - visibleCount), pinnedStart >= 0 ? pinnedStart : Infinity)
    const hiddenCount = outline.findLast((entry) => entry.turnIndex <= windowStart)?.turnIndex ?? windowStart
    const hasHiddenTurns = hiddenCount > 0
    const visibleTurns = hasHiddenTurns ? turns.slice(hiddenCount) : turns

    const handleLoadMore = React.useCallback(() => {
      setVisibleCount((prev) => Math.max(prev, turns.length - hiddenCount) + TURN_INCREMENT)
    }, [turns.length, hiddenCount])

    const handleSelectTurn = React.useCallback(
      (entry: ConversationOutlineEntry) => {
        scrollToMessage()
        setPinnedStartKey(turns[Math.min(hiddenCount, entry.turnIndex)]?.key)
        setPendingKey(entry.key)
      },
      [scrollToMessage, turns, hiddenCount],
    )

    React.useLayoutEffect(() => {
      if (!pendingKey) return
      const element = userMessageRefs.current.get(pendingKey)
      if (element) scrollToMessage(element)
      setPendingKey(undefined)
    }, [pendingKey, scrollToMessage])

    const updateActiveTurn = React.useCallback(() => {
      const container = containerRef.current
      if (!container) return
      const messages = container.querySelectorAll<HTMLElement>('[data-conversation-user]')
      const boundary = container.getBoundingClientRect().top + 80
      let current = messages[0]
      for (const message of messages) {
        if (message.getBoundingClientRect().top > boundary) break
        current = message
      }
      if (container.scrollHeight - container.scrollTop - container.clientHeight <= 2) {
        current = messages[messages.length - 1]
      }
      setActiveKey(current?.dataset.conversationUser)
    }, [containerRef])

    React.useEffect(() => {
      const container = containerRef.current
      if (!container) return
      let frame = 0
      const scheduleUpdate = () => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(updateActiveTurn)
      }
      const observer = new ResizeObserver(scheduleUpdate)
      observer.observe(container)
      if (container.firstElementChild) observer.observe(container.firstElementChild)
      container.addEventListener('scroll', scheduleUpdate, { passive: true })
      scheduleUpdate()
      return () => {
        observer.disconnect()
        container.removeEventListener('scroll', scheduleUpdate)
        cancelAnimationFrame(frame)
      }
    }, [containerRef, updateActiveTurn, firstTurnKey])

    return (
      <div className="relative flex flex-1 min-h-0 min-w-0">
        <ConversationOutline entries={outline} activeKey={activeKey} onSelect={handleSelectTurn} />
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pl-12 pr-4 py-6 text-sm [--code-size:var(--text-ui)] select-text"
          aria-label="对话消息流"
        >
          <div className="max-w-3xl mx-auto space-y-3 [overflow-wrap:anywhere]">
            {hasHiddenTurns && (
              <div className="flex items-center justify-center py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleLoadMore}
                  className="text-sm text-muted-foreground hover:text-foreground h-7 px-3 rounded-full border-border/80 bg-secondary/40 hover:bg-secondary cursor-pointer"
                >
                  加载更早记录（剩余 {hiddenCount} 轮）
                </Button>
              </div>
            )}

            {visibleTurns.map((turn) => {
              if (turn.type === 'agent_status')
                return <AgentStatusRow key={turn.key} agents={turn.agents} status={turn.status} />
              if (turn.type === 'compaction') {
                return (
                  <CompactionCard
                    key={turn.key}
                    kind={turn.kind}
                    summary={turn.summary}
                    tokensBefore={turn.tokensBefore}
                    timestamp={turn.timestamp}
                  />
                )
              }
              if (turn.type === 'custom') {
                return (
                  <PluginMessage
                    key={turn.key}
                    message={turn.message}
                    {...turn.message.source}
                    customType={turn.message.customType}
                    fallback={<div className="whitespace-pre-wrap text-sm">{messageText(turn.message)}</div>}
                  />
                )
              }
              if (turn.type === 'user') {
                const versions = readOnly ? undefined : messageVersions(chat.sessionEntries, turn.message)
                const versionSwitchBusy =
                  typeof turn.message.timestamp === 'number' && switchingVersion === turn.message.timestamp
                return (
                  <div
                    key={turn.key}
                    data-conversation-user={turn.key}
                    ref={(element) => {
                      if (element) userMessageRefs.current.set(turn.key, element)
                      else userMessageRefs.current.delete(turn.key)
                    }}
                  >
                    {!readOnly && editor && turn.message.timestamp === editor.timestamp ? (
                      <InlineMessageEditor editor={editor} />
                    ) : (
                      <ChatMessage
                        message={turn.message}
                        tools={chat.tools}
                        onEdit={readOnly ? undefined : onEditMessage}
                        canEdit={canEditMessages}
                        onCopyError={onCopyError}
                        versions={versions}
                        versionSwitchBusy={versionSwitchBusy}
                        onSwitchVersion={
                          readOnly
                            ? undefined
                            : (version) =>
                                typeof turn.message.timestamp === 'number' &&
                                onSwitchMessageVersion(turn.message.timestamp, version)
                        }
                      />
                    )}
                  </div>
                )
              }
              return (
                <AssistantTurnView
                  key={turn.key}
                  turn={turn}
                  retry={turn.isLive && chat.retry?.kind === 'model' ? chat.retry : undefined}
                  isPaused={Boolean(chat.paused && turn.isLive)}
                  pauseIntervals={chat.pauseIntervals}
                  canFork={canEditMessages}
                  onFork={readOnly ? undefined : onForkReply}
                  onCopyError={onCopyError}
                />
              )
            })}

            {chat.retry?.kind === 'summary' ? (
              <ErrorLine
                message={chat.retry.errorMessage}
                suffix={`重试中（${chat.retry.attempt}/${chat.retry.maxAttempts}）`}
              />
            ) : chat.compactionError ? (
              <ErrorLine message={chat.compactionError} summary="上下文压缩失败" />
            ) : chat.compacting?.active ? (
              <CompactionProgressCard />
            ) : null}

            <div ref={bottomRef} className="h-2" />
          </div>
        </div>

        {/* 回到底部悬浮按钮 */}
        {showScrollBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
            <Button
              size="icon"
              variant="outline"
              className="pointer-events-auto size-9 rounded-full shadow-md bg-card/95 backdrop-blur-xs border-border hover:bg-secondary transition-[background-color,transform] duration-200 ease-out active:scale-95"
              onClick={scrollToBottom}
              aria-label="滚动到底部"
            >
              <ArrowDown className="size-4" />
            </Button>
          </div>
        )}
      </div>
    )
  },
)
