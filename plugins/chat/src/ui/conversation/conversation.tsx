import * as React from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatState, TurnChunk } from '../model/types'
import { ChatMessage } from './chat-message'
import { AssistantTurnView } from './assistant-turn'
import { InlineMessageEditor, type MessageEditorState } from './inline-message-editor'
import { groupConversationTurns } from '../model/conversation-turns'
import { useConversationScroll } from './use-conversation-scroll'
import { Button } from '@pi-meme/ui/components/ui/button'
import { messageVersions } from '../model/message-versions'
import { CompactionCard, CompactionProgressCard } from './compaction-card'

const INITIAL_VISIBLE_TURNS = 30
const TURN_INCREMENT = 30

export const Conversation = React.memo(
  ({
    chat,
    canEditMessages,
    onEditMessage,
    onSwitchMessageVersion,
    onForkReply,
    onCopyError,
    editor,
    switchingVersion,
  }: {
    chat: ChatState
    canEditMessages: boolean
    onEditMessage: (message: Extract<TurnChunk, { type: 'user' }>['message']) => void
    onSwitchMessageVersion: (timestamp: number, version: number) => void
    onForkReply: (timestamp: number) => void
    onCopyError: (message: string) => void
    /** 正在原位置编辑的用户消息，命中该时间戳时用编辑器替换消息气泡。 */
    editor?: MessageEditorState
    /** 正在切换版本的原始消息时间戳，用于展示切换进度。 */
    switchingVersion?: number
  }) => {
    const { containerRef, bottomRef, showScrollBottom, handleScroll, scrollToBottom } = useConversationScroll(chat)

    // 按对话轮次（Turn）聚合消息流：将同一交互轮次内的思考、多次工具调用、Bash 与最终正文聚合成单一轮次卡片
    const turns = React.useMemo(
      () => groupConversationTurns(chat.messages, chat.live, chat.tools, chat.running, chat.stream.completed),
      [chat.messages, chat.live, chat.tools, chat.running, chat.stream.completed],
    )

    const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_TURNS)
    const firstTurnKey = turns[0]?.key
    const prevFirstKeyRef = React.useRef(firstTurnKey)

    // 切换会话时重置窗口大小
    React.useEffect(() => {
      if (prevFirstKeyRef.current !== firstTurnKey) {
        prevFirstKeyRef.current = firstTurnKey
        setVisibleCount(INITIAL_VISIBLE_TURNS)
      }
    }, [firstTurnKey])

    const hasHiddenTurns = turns.length > visibleCount
    const hiddenCount = hasHiddenTurns ? turns.length - visibleCount : 0
    const visibleTurns = hasHiddenTurns ? turns.slice(hiddenCount) : turns

    const handleLoadMore = React.useCallback(() => {
      setVisibleCount((prev) => prev + TURN_INCREMENT)
    }, [])

    return (
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4 py-6 scroll-smooth select-text"
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
                className="text-xs text-muted-foreground hover:text-foreground h-7 px-3 rounded-full border-border/80 bg-secondary/40 hover:bg-secondary cursor-pointer"
              >
                加载更早记录（剩余 {hiddenCount} 轮）
              </Button>
            </div>
          )}

          {visibleTurns.map((turn) => {
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
            if (turn.type === 'user') {
              if (editor && turn.message.timestamp === editor.timestamp)
                return <InlineMessageEditor key={turn.key} editor={editor} />
              const versions = messageVersions(chat.sessionEntries, turn.message)
              const versionSwitchBusy =
                typeof turn.message.timestamp === 'number' && switchingVersion === turn.message.timestamp
              return (
                <ChatMessage
                  key={turn.key}
                  message={turn.message}
                  tools={chat.tools}
                  onEdit={onEditMessage}
                  canEdit={canEditMessages}
                  onCopyError={onCopyError}
                  versions={versions}
                  versionSwitchBusy={versionSwitchBusy}
                  onSwitchVersion={(version) =>
                    typeof turn.message.timestamp === 'number' &&
                    onSwitchMessageVersion(turn.message.timestamp, version)
                  }
                />
              )
            }
            return (
              <AssistantTurnView
                key={turn.key}
                turn={turn}
                canFork={canEditMessages}
                onFork={onForkReply}
                onCopyError={onCopyError}
              />
            )
          })}

          {chat.compacting?.active && <CompactionProgressCard />}

          <div ref={bottomRef} className="h-2" />
        </div>

        {/* 回到底部悬浮按钮 */}
        {showScrollBottom && (
          <div className="fixed bottom-32 right-8 z-20">
            <Button
              size="icon"
              variant="outline"
              className="size-9 rounded-full shadow-md bg-card/90 backdrop-blur-xs border-border hover:bg-secondary active:scale-95"
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
