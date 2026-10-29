import type { ChatStream } from '../model/chat-stream'
import * as React from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatState, ConversationOutlineEntry, TurnChunk } from '../model/types'
import type { PiModel } from '@pi-meme/contracts/pi'
import type { PlanDocument, PlanState } from '@pi-meme/contracts/plan'
import { ChatMessage } from './chat-message'
import { AssistantTurnView } from './assistant-turn'
import { InlineMessageEditor, type MessageEditorState } from './inline-message-editor'
import { createConversationTurnProjector } from '../model/conversation-turns'
import { mainMessage, projectMainConversation } from '../model/conversation-projection'
import { projectAgentConversation } from '../model/agent-collaboration'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { useConversationScroll } from './use-conversation-scroll'
import { Button } from '@pi-meme/ui/components/ui/button'
import { CompactionCard, CompactionProgressCard } from './compaction-card'
import { conversationOutline } from '../model/conversation-outline'
import { ConversationOutline } from './conversation-outline'
import { PluginConversationScope, PluginMessage } from '@pi-meme/ui/components/plugin-message'
import { PluginMessageActions } from '@pi-meme/ui/components/plugin-message-actions'
import { messageText } from '../model/message-text'
import { AgentStatusRow } from './agent-status-row'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { cn } from '@pi-meme/ui/lib/utils'
import { MessageImageLoaderContext, type MessageImageLoader } from '../content/message-image'
import { modelChangesForConversation } from '../model/model-changes'
import { ModelChangeRow } from './model-change-row'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'
import { TurnChangesCard } from './turn-changes'
import { MarkdownFileSessionContext, MarkdownWorkingDirectoryContext } from '../content/markdown-link'
import type { SessionRef } from '@pi-meme/contracts/app-host'

function noSubscription() {
  return () => {}
}

const INITIAL_VISIBLE_TURNS = 30
const TURN_INCREMENT = 30

// 按会话保留“加载更早记录”展开的窗口大小，切回会话时连同滚动位置一起恢复。
const visibleWindows = new Map<string, number>()

export const Conversation = React.memo(
  ({
    chat: initialChat,
    stream,
    canEditMessages,
    canForkReplies = canEditMessages,
    onEditMessage,
    onForkReply,
    onCopyError,
    editor,
    sessionKey,
    loadImage,
    cwd,
    fileSession,
    readOnly = false,
    agentOnly = false,
    agent,
    models = [],
    renderPlan,
    planState,
    onLoadOlder,
    historyLoading = false,
    turnChanges,
    onViewChanges,
    onUndoChanges,
    changesDisabled,
  }: {
    chat: ChatState
    stream?: ChatStream
    canEditMessages: boolean
    canForkReplies?: boolean
    onEditMessage: (message: Extract<TurnChunk, { type: 'user' }>['message']) => void
    onForkReply: (timestamp: number) => void
    onCopyError: (message: string) => void
    /** 正在原位置编辑的用户消息，命中该原生 entry ID时用编辑器替换消息气泡。 */
    editor?: MessageEditorState
    /** 当前会话标识，用于按会话恢复滚动位置。 */
    sessionKey?: string
    loadImage?: MessageImageLoader
    cwd?: string
    fileSession?: SessionRef
    readOnly?: boolean
    agentOnly?: boolean
    agent?: AgentSummary
    models?: PiModel[]
    renderPlan?: (document: PlanDocument) => React.ReactNode
    planState?: PlanState | null
    onLoadOlder?: () => Promise<boolean>
    historyLoading?: boolean
    turnChanges?: readonly TurnChanges[]
    onViewChanges?: (entryId: string, path?: string) => void
    onUndoChanges?: (entryId: string) => Promise<void>
    changesDisabled?: boolean
  }) => {
    const chat = React.useSyncExternalStore(
      stream?.subscribe ?? noSubscription,
      stream?.getSnapshot ?? (() => initialChat),
      stream?.getSnapshot ?? (() => initialChat),
    )
    const {
      containerRef,
      showScrollTop,
      showScrollBottom,
      handleScroll,
      scrollToBottom,
      scrollToMessage,
      handleActivityToggle,
    } = useConversationScroll(chat, sessionKey)

    const stableView = React.useMemo(
      () =>
        readOnly
          ? { messages: chat.messages, tools: chat.tools, agentStatuses: [] }
          : projectMainConversation({
              messages: chat.messages,
              live: null,
              tools: chat.tools,
              agents: chat.agents,
              agentMessages: chat.agentMessages,
            }),
      [chat.messages, chat.tools, chat.agents, chat.agentMessages, readOnly],
    )
    const modelChanges = React.useMemo(
      () => modelChangesForConversation(chat.sessionEntries, stableView.messages),
      [chat.sessionEntries, stableView.messages],
    )
    const groupTurns = React.useMemo(() => createConversationTurnProjector(), [])
    // 按对话轮次（Turn）聚合消息流：将同一交互轮次内的思考、多次工具调用、Bash 与最终正文聚合成单一轮次卡片
    const { turns, finalReplyKeys } = React.useMemo(() => {
      const view = {
        ...stableView,
        live: readOnly ? chat.live : chat.live ? (mainMessage(chat.live) as ChatState['live']) : null,
      }
      const grouped =
        agentOnly && agent
          ? projectAgentConversation(chat, agent)
          : groupTurns(
              view.messages,
              view.live,
              view.tools,
              chat.running,
              chat.stream.completed,
              'agentStatuses' in view ? view.agentStatuses : [],
              chat.runIntervals,
              modelChanges,
            )
      const finalReplyKeys = new Set<string>()
      let canBeFinal = !chat.running && !chat.live
      // 子代理状态只切分展示段，每条用户输入仅最后一个已完成的助手段保留消息操作。
      for (let index = grouped.length - 1; index >= 0; index--) {
        const turn = grouped[index]!
        if (turn.type === 'user') canBeFinal = true
        else if (turn.type === 'assistant_turn') {
          if (canBeFinal && !turn.isLive) finalReplyKeys.add(turn.key)
          canBeFinal = false
        }
      }
      return {
        turns: agentOnly
          ? grouped.filter(
              (turn) =>
                turn.type !== 'user' &&
                !(turn.type === 'custom' && turn.message.customType === 'pi-meme-collaboration'),
            )
          : grouped,
        finalReplyKeys,
      }
    }, [chat, readOnly, agentOnly, agent, stableView, modelChanges, groupTurns])
    const outline = React.useMemo(() => (agentOnly ? [] : conversationOutline(turns)), [turns, agentOnly])
    const plansByTool = React.useMemo(() => {
      const plans = new Map<string, PlanDocument>()
      for (const message of chat.messages) {
        if (message.role !== 'toolResult' || message.toolName !== 'save_plan' || message.isError) continue
        const value = message.details as PlanDocument | undefined
        if (
          value &&
          typeof value.id === 'string' &&
          typeof value.markdown === 'string' &&
          typeof value.title === 'string'
        )
          plans.set(message.toolCallId, value)
      }
      return plans
    }, [chat.messages])
    const effectivePlanState = planState === undefined ? chat.planState : planState
    const currentPlan =
      effectivePlanState?.document ??
      (!effectivePlanState && planState !== null ? chat.planDocuments?.at(-1) : undefined)
    const sourceMessage = effectivePlanState?.sourceEntryId
      ? chat.messages.find(
          (message) => message.sourceEntry?.id === effectivePlanState.sourceEntryId && message.role === 'toolResult',
        )
      : undefined
    const sourceToolId =
      sourceMessage?.role === 'toolResult'
        ? sourceMessage.toolCallId
        : !effectivePlanState
          ? [...plansByTool].findLast(
              ([, document]) =>
                currentPlan && document.id === currentPlan.id && document.revision === currentPlan.revision,
            )?.[0]
          : undefined
    function planReply(turn: Extract<TurnChunk, { type: 'assistant_turn' }>): React.ReactNode {
      const callIds = new Set(
        turn.sourceMessages?.flatMap((message) =>
          message.role === 'assistant'
            ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []))
            : [],
        ),
      )
      function findPlan(items: readonly { id: string; children?: readonly { id: string }[] }[]): React.ReactNode {
        for (const item of [...items].reverse()) {
          if (plansByTool.has(item.id))
            return item.id === sourceToolId && currentPlan ? renderPlan?.(currentPlan) : <React.Fragment />
          if (item.children) {
            const nested = findPlan(item.children)
            if (nested) return nested
          }
        }
        return undefined
      }
      return findPlan(turn.activities.filter((item) => callIds.has(item.id)))
    }

    const [visible, setVisible] = React.useState({ key: sessionKey, count: INITIAL_VISIBLE_TURNS })
    if (visible.key !== sessionKey)
      setVisible({
        key: sessionKey,
        count: (sessionKey ? visibleWindows.get(sessionKey) : undefined) ?? INITIAL_VISIBLE_TURNS,
      })
    const visibleCount =
      visible.key === sessionKey
        ? visible.count
        : ((sessionKey ? visibleWindows.get(sessionKey) : undefined) ?? INITIAL_VISIBLE_TURNS)
    const setVisibleCount = React.useCallback(
      (next: number | ((previous: number) => number)) => {
        setVisible((value) => {
          const previous =
            value.key === sessionKey
              ? value.count
              : ((sessionKey ? visibleWindows.get(sessionKey) : undefined) ?? INITIAL_VISIBLE_TURNS)
          const count = typeof next === 'function' ? next(previous) : next
          if (sessionKey) {
            visibleWindows.delete(sessionKey)
            visibleWindows.set(sessionKey, count)
            if (visibleWindows.size > 200) visibleWindows.delete(visibleWindows.keys().next().value!)
          }
          return { key: sessionKey, count }
        })
      },
      [sessionKey],
    )
    const [pinnedStartKey, setPinnedStartKey] = React.useState<string>()
    const [activeKey, setActiveKey] = React.useState<string>()
    const [pendingKey, setPendingKey] = React.useState<string>()
    const userMessageRefs = React.useRef(new Map<string, HTMLDivElement>())
    const firstTurnKey = turns[0]?.key
    const prevFirstKeyRef = React.useRef(firstTurnKey)

    // 切换会话时清理锚点；展开的窗口大小已按会话保存，不再统一重置。
    React.useEffect(() => {
      if (prevFirstKeyRef.current !== firstTurnKey) {
        prevFirstKeyRef.current = firstTurnKey
        setPinnedStartKey(undefined)
        setPendingKey(undefined)
      }
    }, [firstTurnKey])

    const pinnedStart = pinnedStartKey ? turns.findIndex((turn) => turn.key === pinnedStartKey) : -1
    const windowStart = Math.min(Math.max(0, turns.length - visibleCount), pinnedStart >= 0 ? pinnedStart : Infinity)
    const hiddenCount = outline.findLast((entry) => entry.turnIndex <= windowStart)?.turnIndex ?? windowStart
    const hasHiddenTurns = hiddenCount > 0
    const visibleTurns = hasHiddenTurns ? turns.slice(hiddenCount) : turns
    const currentSession = React.useRef(sessionKey)
    currentSession.current = sessionKey

    const handleLoadMore = React.useCallback(async () => {
      if (!hasHiddenTurns && chat.messagePage && onLoadOlder) {
        if (!(await onLoadOlder()) || currentSession.current !== sessionKey) return
      }
      setVisibleCount((prev) => Math.max(prev, turns.length - hiddenCount) + TURN_INCREMENT)
    }, [turns.length, hiddenCount, hasHiddenTurns, chat.messagePage, onLoadOlder, sessionKey])

    const handleSelectTurn = React.useCallback(
      (entry: ConversationOutlineEntry) => {
        setPinnedStartKey(turns[Math.min(hiddenCount, entry.turnIndex)]?.key)
        setPendingKey(entry.key)
      },
      [turns, hiddenCount],
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
      if (!container || agentOnly) return
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
    }, [containerRef, updateActiveTurn, firstTurnKey, agentOnly])

    const content = React.createElement(
      PluginConversationScope,
      { publicSession: !agentOnly },
      React.createElement(
        MessageImageLoaderContext.Provider,
        { value: loadImage },
        <div className="chat-surface relative flex flex-1 min-h-0 min-w-0">
          <ConversationOutline entries={outline} activeKey={activeKey} onSelect={handleSelectTurn} />
          <div
            ref={containerRef}
            onScroll={handleScroll}
            data-overflow-top={showScrollTop}
            className={cn(
              'scroll-fade flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto py-6 text-sm select-text [scrollbar-gutter:stable_both-edges]',
              agentOnly && 'px-4',
            )}
            aria-label="对话消息流"
          >
            <div
              className={cn(
                'space-y-3 [overflow-wrap:anywhere]',
                agentOnly ? 'max-w-3xl mx-auto' : 'chat-content-column',
              )}
            >
              {(hasHiddenTurns || (chat.messagePage && onLoadOlder)) && (
                <div className="flex items-center justify-center py-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={historyLoading}
                    className="text-sm text-muted-foreground hover:text-foreground h-7 px-3 rounded-full border-border/80 bg-secondary/40 hover:bg-secondary cursor-pointer"
                  >
                    {historyLoading
                      ? '正在加载更早记录…'
                      : hasHiddenTurns
                        ? `加载更早记录（剩余 ${hiddenCount} 轮）`
                        : '加载更早记录'}
                  </Button>
                </div>
              )}

              {visibleTurns.map((turn) => {
                if (turn.type === 'model_change')
                  return <ModelChangeRow key={turn.key} from={turn.from} to={turn.to} models={models} />
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
                    <div key={turn.key}>
                      <PluginMessage
                        message={turn.message}
                        {...turn.message.source}
                        customType={turn.message.customType}
                        fallback={<div className="whitespace-pre-wrap text-sm">{messageText(turn.message)}</div>}
                      />
                      <PluginMessageActions
                        role="custom"
                        entries={turn.message.sourceEntry ? [turn.message.sourceEntry] : []}
                        displayedText={messageText(turn.message)}
                        state="complete"
                        source={turn.message.source}
                        customType={turn.message.customType}
                      />
                    </div>
                  )
                }
                if (turn.type === 'user') {
                  return (
                    <div
                      key={turn.key}
                      data-conversation-user={turn.key}
                      ref={(element) => {
                        if (element) userMessageRefs.current.set(turn.key, element)
                        else userMessageRefs.current.delete(turn.key)
                      }}
                    >
                      {!readOnly && editor && turn.message.sourceEntry?.id === editor.entryId ? (
                        <InlineMessageEditor editor={editor} />
                      ) : (
                        <ChatMessage
                          message={turn.message}
                          tools={chat.tools}
                          onEdit={readOnly ? undefined : onEditMessage}
                          canEdit={canEditMessages}
                          onCopyError={onCopyError}
                        />
                      )}
                    </div>
                  )
                }
                return (
                  <AssistantTurnView
                    key={turn.key}
                    turn={turn}
                    isFinalReply={finalReplyKeys.has(turn.key)}
                    retry={turn.isLive && chat.retry?.kind === 'model' ? chat.retry : undefined}
                    isPaused={Boolean(chat.paused && turn.isLive)}
                    pauseIntervals={chat.pauseIntervals}
                    canFork={canForkReplies}
                    onFork={readOnly ? undefined : onForkReply}
                    onCopyError={onCopyError}
                    onActivityToggle={handleActivityToggle}
                    reply={!agentOnly && !turn.isLive && renderPlan ? planReply(turn) : undefined}
                    changes={(() => {
                      if (!finalReplyKeys.has(turn.key) || !onViewChanges || !onUndoChanges) return
                      const changes = turnChanges?.find((item) => item.entryId === turn.userEntryId)
                      return changes ? (
                        <TurnChangesCard
                          changes={changes}
                          onView={onViewChanges}
                          onUndo={onUndoChanges}
                          disabled={changesDisabled}
                        />
                      ) : undefined
                    })()}
                  />
                )
              })}

              {!readOnly &&
                editor &&
                !turns.some((turn) => turn.type === 'user' && turn.message.sourceEntry?.id === editor.entryId) && (
                  <InlineMessageEditor editor={editor} />
                )}

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

              <div className="h-2" />
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
        </div>,
      ),
    )
    return (
      <MarkdownFileSessionContext value={fileSession}>
        <MarkdownWorkingDirectoryContext value={agent?.cwd ?? cwd}>{content}</MarkdownWorkingDirectoryContext>
      </MarkdownFileSessionContext>
    )
  },
)
