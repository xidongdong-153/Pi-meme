import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  ChevronDown,
  ListTodo,
  LoaderCircle,
  Paperclip,
  Plus,
  Square,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { cn } from './utils'
import { motionTransition } from './motion'
import { attachmentUrl, openBotConversation, request, RequestError } from '../client/api'
import { BotSidebar } from './bot-sidebar'
import { formatChatTime, hasTimeBreak } from './chat-time'
import { buildMessageTimeline } from './chat-timeline'
import { CopyButton, MessageContent } from './message-content'
import { Tooltip, TooltipContent, TooltipTrigger } from './primitives'
import type {
  AcceptedMessage,
  Attachment,
  Bot,
  Conversation,
  Message,
  ModelConfig,
  Snapshot,
  Task,
  TaskLive,
} from '../shared/types'
import { ConversationOverview } from './conversation-overview'
import { TaskInteractionCards } from './task-interactions'
import { TaskTree } from './task-tree'
import { MemoryEditor } from './memory-editor'
import { attachmentAccept, imageMimeTypes, readableAttachment } from '../shared/attachment-types'
import {
  Avatar,
  BrandMark,
  Button,
  Check,
  CollapsibleSection,
  date,
  Empty,
  ErrorText,
  Field,
  Form,
  GroupAvatar,
  Input,
  Modal,
  Select,
  Status,
  Textarea,
  useAction,
} from './common'
import type { PageProps } from './common'

const BotEditorDialog = lazy(() => import('./bots').then((module) => ({ default: module.BotEditorDialog })))
const active = new Set(['queued', 'running', 'waiting', 'stopping'])
function mergeLive(previous: TaskLive[], incoming: TaskLive[]) {
  const values = new Map(previous.map((value) => [value.taskId, value]))
  for (const value of incoming) {
    const current = values.get(value.taskId)
    if (
      !current ||
      (value.generation ?? 0) > (current.generation ?? 0) ||
      ((value.generation ?? 0) === (current.generation ?? 0) && value.version >= current.version)
    )
      values.set(value.taskId, value)
  }
  return [...values.values()]
}
export function Chats({
  snapshot,
  refresh,
  navigate,
  selectedId,
  listOpen,
  online,
  openSettings,
  logout,
}: PageProps & {
  selectedId?: string
  listOpen: boolean
  online: boolean
  openSettings: (tab?: string) => void
  logout: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [editingBot, setEditingBot] = useState<Bot | null | undefined>()
  const [openingError, setOpeningError] = useState<unknown>()
  const openGeneration = useRef(0)
  const [detailStates, setDetailStates] = useState<Record<string, 'overview' | 'edit' | 'tasks' | undefined>>({})
  const [detailDirty, setDetailDirty] = useState(false)
  const [detailSaving, setDetailSaving] = useState(false)
  const [live, setLive] = useState<TaskLive[]>(snapshot.live ?? [])
  const details = selectedId ? detailStates[selectedId] : undefined
  const settingsReturn = useRef<
    | {
        conversationId?: string
        view?: 'overview' | 'edit' | 'tasks'
        bot?: Bot | null
        task?: { id: string; conversationId: string }
      }
    | undefined
  >(undefined)
  const returnToTaskList = useRef(false)
  const detailTrigger = useRef<HTMLButtonElement>(null)
  const pendingDetails = useRef<string | undefined>(undefined)
  const showDetails = useCallback(
    (view: 'overview' | 'edit' | 'tasks') => {
      if (!selectedId) return
      pendingDetails.current = selectedId
      motionTransition('chat-detail', () => setDetailStates((previous) => ({ ...previous, [selectedId]: view })))
    },
    [selectedId],
  )
  const taskTrigger = useRef<HTMLElement | null>(null)
  const [taskSelection, setTaskSelection] = useState<{ id: string; conversationId: string }>()
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const latestMessages = useRef(messages)
  latestMessages.current = messages
  const [cursors, setCursors] = useState<Record<string, string | undefined>>({})
  const [errors, setErrors] = useState<Record<string, unknown>>({})
  const error = selectedId ? errors[selectedId] : undefined
  const setError = (cause: unknown) => {
    if (selectedId) setErrors((previous) => ({ ...previous, [selectedId]: cause }))
  }
  const [olderLoading, setOlderLoading] = useState<Record<string, boolean>>({})
  const olderRequests = useRef(new Set<string>())
  const latestRead = useRef(0)
  const [readRevision, setReadRevision] = useState(0)
  const conversation = snapshot.conversations.find((c) => c.id === selectedId)
  const currentBot =
    conversation?.kind === 'direct' ? snapshot.bots.find((bot) => bot.id === conversation.coordinatorId) : undefined
  const title = currentBot?.name ?? conversation?.name ?? ''
  const tasks = snapshot.tasks.filter((t) => t.conversationId === selectedId)
  const deliveries = snapshot.deliveries.filter((delivery) => delivery.conversationId === selectedId)
  useEffect(() => {
    pendingDetails.current = undefined
  }, [details, selectedId])
  useEffect(() => {
    const cancelOpening = (event: KeyboardEvent) => {
      const target = pendingDetails.current
      if (
        !target ||
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        document.querySelector('[data-bot-modal], .bot-sidebar[aria-modal="true"]')
      )
        return
      event.preventDefault()
      pendingDetails.current = undefined
      // Cancel urgently so the queued opening cannot reappear after Escape.
      setDetailStates((previous) => ({ ...previous, [target]: undefined }))
    }
    window.addEventListener('keydown', cancelOpening)
    return () => window.removeEventListener('keydown', cancelOpening)
  }, [])
  useEffect(() => setLive((previous) => mergeLive(previous, snapshot.live ?? [])), [snapshot.live])
  useEffect(() => {
    const receive = (event: Event) =>
      setLive((previous) => mergeLive(previous, (event as CustomEvent<TaskLive[]>).detail))
    window.addEventListener('bots:live', receive)
    return () => window.removeEventListener('bots:live', receive)
  }, [])
  useEffect(() => {
    const restore = () => {
      const target = settingsReturn.current
      settingsReturn.current = undefined
      if (!target) return
      if ('bot' in target) setEditingBot(target.bot)
      else if (target.task) setTaskSelection(target.task)
      else if (target.conversationId === selectedId && target.view) showDetails(target.view)
    }
    window.addEventListener('bots:settings-closed', restore)
    return () => window.removeEventListener('bots:settings-closed', restore)
  }, [selectedId, showDetails])
  function configure(tab = 'models') {
    if (editingBot !== undefined) {
      settingsReturn.current = { bot: editingBot }
      setEditingBot(undefined)
    } else if (taskSelection) {
      settingsReturn.current = { task: taskSelection }
      setTaskSelection(undefined)
    } else if (selectedId && details) {
      settingsReturn.current = { conversationId: selectedId, view: details }
      setDetailStates((previous) => ({ ...previous, [selectedId]: undefined }))
    }
    openSettings(tab)
  }
  function selectConversation(id: string | undefined) {
    openGeneration.current++
    setOpeningError(undefined)
    navigate('chats', id)
  }
  async function selectBot(bot: Bot) {
    const generation = ++openGeneration.current
    setOpeningError(undefined)
    if (bot.webConversationId && snapshot.conversations.some((item) => item.id === bot.webConversationId)) {
      navigate('chats', bot.webConversationId)
      return
    }
    try {
      const target = await openBotConversation(bot.id)
      await refresh()
      if (generation === openGeneration.current) navigate('chats', target.id)
    } catch (cause) {
      if (generation === openGeneration.current) setOpeningError(cause)
    }
  }
  useEffect(() => {
    const edit = (event: Event) => {
      const id = (event as CustomEvent<string | undefined>).detail
      setEditingBot(snapshot.bots.find((bot) => bot.id === id) ?? null)
    }
    window.addEventListener('bots:edit-bot', edit)
    return () => window.removeEventListener('bots:edit-bot', edit)
  }, [snapshot.bots])
  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    const target = selectedId
    const generation = ++latestRead.current
    setErrors((previous) => ({ ...previous, [target]: undefined }))
    void request<{ items: Message[]; nextCursor?: string }>(`/conversations/${encodeURIComponent(target)}/messages`, {
      signal: controller.signal,
    })
      .then(async (data) => {
        let items = data.items
        let cursor = data.nextCursor
        const cachedMessages = latestMessages.current[target]
        const knownSequence = cachedMessages ? (cachedMessages.at(-1)?.sequence ?? 0) : undefined
        if (knownSequence !== undefined) {
          while (items.length && items[0].sequence > knownSequence + 1 && cursor) {
            const page = await request<{ items: Message[]; nextCursor?: string }>(
              `/conversations/${encodeURIComponent(target)}/messages?cursor=${encodeURIComponent(cursor)}`,
              { signal: controller.signal },
            )
            items = [...page.items, ...items]
            cursor = page.nextCursor
          }
        }
        if (controller.signal.aborted) return
        setMessages((previous) => ({
          ...previous,
          [target]: [
            ...new Map([...(previous[target] ?? []), ...items].map((message) => [message.id, message])).values(),
          ].sort((a, b) => a.sequence - b.sequence),
        }))
        setCursors((previous) => (target in previous ? previous : { ...previous, [target]: cursor }))
      })
      .catch((cause) => {
        if (!controller.signal.aborted && generation === latestRead.current)
          setErrors((previous) => ({ ...previous, [target]: cause }))
      })
    return () => controller.abort()
  }, [selectedId, snapshot.cursor, readRevision])
  async function older() {
    if (!selectedId || !cursors[selectedId] || olderRequests.current.has(selectedId)) return
    const target = selectedId
    olderRequests.current.add(target)
    setOlderLoading((previous) => ({ ...previous, [target]: true }))
    setErrors((previous) => ({ ...previous, [target]: undefined }))
    try {
      const data = await request<{ items: Message[]; nextCursor?: string }>(
        `/conversations/${encodeURIComponent(selectedId)}/messages?cursor=${encodeURIComponent(cursors[selectedId]!)}`,
      )
      setMessages((previous) => ({
        ...previous,
        [selectedId]: [
          ...new Map([...data.items, ...(previous[selectedId] ?? [])].map((m) => [m.id, m])).values(),
        ].sort((a, b) => a.sequence - b.sequence),
      }))
      setCursors((previous) => ({ ...previous, [selectedId]: data.nextCursor }))
    } catch (cause) {
      setErrors((previous) => ({ ...previous, [target]: cause }))
    } finally {
      olderRequests.current.delete(target)
      setOlderLoading((previous) => ({ ...previous, [target]: false }))
    }
  }
  function openTask(id: string) {
    if (!selectedId) return
    returnToTaskList.current = details === 'tasks'
    taskTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    motionTransition('chat-task', () => {
      setDetailStates((previous) => ({ ...previous, [selectedId]: undefined }))
      setTaskSelection({ id, conversationId: selectedId })
    })
  }
  function closeTask() {
    motionTransition('chat-task', () => {
      setTaskSelection(undefined)
      if (returnToTaskList.current && selectedId)
        setDetailStates((previous) => ({ ...previous, [selectedId]: 'tasks' }))
    })
    const target = taskTrigger.current
    if (target?.isConnected) target.focus({ preventScroll: true })
    else detailTrigger.current?.focus({ preventScroll: true })
  }
  const closeDetails = useCallback(() => {
    if (!selectedId || detailSaving || (detailDirty && !confirm('离开当前编辑？仍有未保存的修改。'))) return
    pendingDetails.current = undefined
    motionTransition('chat-detail', () => setDetailStates((previous) => ({ ...previous, [selectedId]: undefined })))
  }, [selectedId, detailDirty, detailSaving])

  return (
    <div className={cn('split-page chats-page', selectedId && 'has-selection')}>
      <BotSidebar
        snapshot={snapshot}
        open={listOpen}
        selectedId={selectedId}
        messages={messages}
        openBot={(bot) => void selectBot(bot)}
        openGroup={selectConversation}
        createBot={() => setEditingBot(null)}
        createGroup={() => setCreating(true)}
        openSettings={openSettings}
        logout={logout}
      />
      <section className="conversation-main">
        {conversation ? (
          <>
            <div className="chat-heading">
              <button
                className="chat-title"
                aria-label={`${title} · 详情`}
                aria-haspopup="dialog"
                aria-expanded={Boolean(details)}
                onClick={() => showDetails('overview')}
              >
                {conversation.kind === 'group' ? (
                  <GroupAvatar memberIds={conversation.memberIds} bots={snapshot.bots} />
                ) : (
                  <Avatar name={title} avatar={currentBot?.avatar} />
                )}
                <h1>{title}</h1>
                <ChevronDown size={13} />
              </button>
              <div className="chat-header-actions">
                {!online && (
                  <span className="connection-indicator" role="status">
                    离线
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      ref={detailTrigger}
                      variant="ghost"
                      size="icon"
                      aria-label={`任务记录${tasks.some((task) => task.status === 'waiting') ? '，有待处理事项' : ''}`}
                      aria-haspopup="dialog"
                      aria-expanded={details === 'tasks'}
                      onClick={() => showDetails('tasks')}
                    >
                      <ListTodo size={19} strokeWidth={1.7} />
                      {tasks.some((task) => task.status === 'waiting') && (
                        <span className="task-attention-dot" aria-hidden="true" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>任务记录</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <ErrorText error={openingError ?? error} />
            <MessageList
              conversationId={conversation.id}
              messages={messages[conversation.id] ?? []}
              attachments={snapshot.attachments}
              tasks={tasks}
              snapshot={snapshot}
              refresh={refresh}
              settings={configure}
              live={live.filter((value) => value.conversationId === conversation.id)}
              openTask={openTask}
              loaded={conversation.id in messages}
              error={error}
              retry={() => setReadRevision((value) => value + 1)}
              olderLoading={Boolean(olderLoading[conversation.id])}
              older={cursors[conversation.id] ? older : undefined}
            />
            <Composer
              conversation={conversation}
              name={title}
              bots={snapshot.bots}
              models={snapshot.models}
              defaultModelId={snapshot.modelSettings.defaultModelId}
              timezone={snapshot.settings.timezone}
              configureModels={() => configure('models')}
              attachments={snapshot.attachments}
              online={online}
              openSettings={configure}
              refresh={refresh}
              busyTasks={tasks.filter((t) => active.has(t.status))}
            />
          </>
        ) : selectedId ? (
          <Empty
            action={
              <Button variant="outline" onClick={() => navigate('chats')}>
                返回 Bot 列表
              </Button>
            }
          >
            此聊天不存在或已不可访问
          </Empty>
        ) : (
          <div className="chat-welcome">
            <span className="welcome-mark">
              <BrandMark />
            </span>
            <h1>{snapshot.bots.length ? '今天想做些什么？' : '你的助理，从这里开始'}</h1>
            <div className="inline-actions">
              {snapshot.bots[0] ? (
                <Button variant="outline" onClick={() => void selectBot(snapshot.bots[0])}>
                  与 {snapshot.bots[0].name} 聊天
                </Button>
              ) : (
                <Button onClick={() => setEditingBot(null)}>创建 Bot</Button>
              )}
              {!snapshot.models.some((model) => model.kind === 'text') && (
                <Button variant="ghost" onClick={() => openSettings('models')}>
                  配置模型
                </Button>
              )}
            </div>
            <ErrorText error={openingError} />
          </div>
        )}
      </section>
      {details && conversation && (
        <Modal
          placement="right"
          title={
            details === 'tasks' ? '任务记录' : details === 'edit' ? (currentBot ? '编辑 Bot' : '编辑群组') : '详情'
          }
          className="ds-bot-details"
          onClose={closeDetails}
        >
          <div className="conversation-details">
            {details === 'overview' ? (
              <ConversationOverview
                {...{ conversation, snapshot, refresh }}
                bot={currentBot}
                edit={() => showDetails('edit')}
                tasks={() => showDetails('tasks')}
                settings={configure}
                openBot={(bot) => {
                  closeDetails()
                  void selectBot(bot)
                }}
                removed={() => {
                  closeDetails()
                  navigate('chats')
                }}
              />
            ) : details === 'edit' ? (
              currentBot ? (
                <Suspense fallback={<p role="status">正在读取编辑器…</p>}>
                  <BotEditorDialog
                    {...{ snapshot, refresh, navigate }}
                    bot={currentBot}
                    inline
                    onDirtyChange={setDetailDirty}
                    onSavingChange={setDetailSaving}
                    onSettings={configure}
                    close={() => showDetails('overview')}
                  />
                </Suspense>
              ) : (
                <ConversationDetails
                  key={conversation.id}
                  {...{ conversation, snapshot, refresh, navigate }}
                  onDirtyChange={setDetailDirty}
                  onSavingChange={setDetailSaving}
                  done={() => showDetails('overview')}
                />
              )
            ) : (
              <>
                {tasks.length ? (
                  <TaskTree tasks={tasks} openTask={openTask} refresh={refresh} />
                ) : (
                  <p className="muted">暂无任务</p>
                )}
                {deliveries.length > 0 && <h3>渠道投递</h3>}
                {deliveries.map((delivery) => (
                  <div key={delivery.id} className="record">
                    <Status value={delivery.status} />
                    <p>{delivery.error}</p>
                    {['failed', 'unknown'].includes(delivery.status) && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (delivery.status === 'unknown' && !confirm('投递结果未知，再次发送可能造成重复。继续？'))
                            return
                          void request(`/deliveries/${delivery.id}/attempts`, {
                            method: 'POST',
                            body: { confirmUnknown: delivery.status === 'unknown' },
                          })
                            .then(refresh)
                            .catch(setError)
                        }}
                      >
                        再次投递已有结果
                      </Button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </Modal>
      )}
      {editingBot !== undefined && (
        <Suspense
          fallback={
            <div className="dialog-loading" role="status">
              正在打开 Bot 设置…
            </div>
          }
        >
          <BotEditorDialog
            {...{ snapshot, refresh, navigate }}
            bot={editingBot ?? undefined}
            close={() => setEditingBot(undefined)}
            onSettings={configure}
            created={(bot) => {
              if (!editingBot) void selectBot(bot)
            }}
          />
        </Suspense>
      )}
      {creating && (
        <NewGroup
          bots={snapshot.bots}
          close={() => motionTransition('bot-modal', () => setCreating(false))}
          done={async (id) => {
            await refresh().catch(() => {})
            motionTransition('bot-modal', () => {
              navigate('chats', id)
              setCreating(false)
            })
          }}
        />
      )}
      {taskSelection && taskSelection.conversationId === selectedId && (
        <TaskDetails
          task={snapshot.tasks.find((task) => task.id === taskSelection.id && task.conversationId === selectedId)}
          tasks={snapshot.tasks}
          settings={configure}
          refresh={refresh}
          close={closeTask}
          navigate={navigate}
        />
      )}
    </div>
  )
}
type ReadingPosition = { atBottom: boolean; top: number; anchorId?: string; offset: number }
function readPosition(id: string): ReadingPosition | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(`bots.reading.v1:${id}`) ?? 'null') as ReadingPosition | null
    if (value && typeof value.atBottom === 'boolean' && Number.isFinite(value.top) && Number.isFinite(value.offset))
      return value
  } catch {
    /* Reading position is optional browser state. */
  }
  return undefined
}
function capturePosition(node: HTMLElement): ReadingPosition {
  const top = node.getBoundingClientRect().top
  const anchor = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (message) => message.getBoundingClientRect().bottom > top + 8,
  )
  return {
    atBottom: node.scrollHeight - node.scrollTop - node.clientHeight < 60,
    top: node.scrollTop,
    anchorId: anchor?.dataset.messageId,
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
  }
}
function placePosition(node: HTMLElement, position: ReadingPosition): boolean {
  if (position.atBottom) {
    node.scrollTop = node.scrollHeight
    return true
  }
  const anchor = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (message) => message.dataset.messageId === position.anchorId,
  )
  if (anchor) {
    node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - position.offset
    return true
  }
  return false
}
function MessageList({
  conversationId,
  messages,
  attachments,
  tasks,
  snapshot,
  refresh,
  settings,
  live,
  openTask,
  loaded,
  error,
  retry,
  olderLoading,
  older,
}: {
  conversationId: string
  messages: Message[]
  attachments: Attachment[]
  tasks: Task[]
  snapshot: Snapshot
  refresh: () => Promise<void>
  settings: (tab: string) => void
  live: TaskLive[]
  openTask: (id: string) => void
  loaded: boolean
  error: unknown
  retry: () => void
  olderLoading: boolean
  older?: () => Promise<void>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, ReadingPosition>())
  const target = useRef('')
  const restoring = useRef<ReadingPosition | null>(null)
  const previous = useRef<{ loaded: boolean; sequence: number } | null>(null)
  const [restoringHistory, setRestoringHistory] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [arrivalIds, setArrivalIds] = useState<string[]>([])
  const hasOlder = Boolean(older)
  const conversation = snapshot.conversations.find((item) => item.id === conversationId)
  const items = loaded ? buildMessageTimeline(messages, tasks, hasOlder) : []
  const savePosition = useCallback(() => {
    const node = ref.current
    if (!node || !node.clientHeight || !target.current || restoring.current) return
    const position = capturePosition(node)
    positions.current.set(target.current, position)
    try {
      sessionStorage.setItem(`bots.reading.v1:${target.current}`, JSON.stringify(position))
    } catch {
      /* Keep the in-memory position when browser storage is full. */
    }
    setShowJump(!position.atBottom)
  }, [])
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const changed = target.current !== conversationId
    if (changed) {
      target.current = conversationId
      restoring.current = positions.current.get(conversationId) ??
        readPosition(conversationId) ?? { atBottom: true, top: 0, offset: 0 }
      previous.current = null
      setArrivalIds([])
      setShowJump(false)
    }
    if (!loaded) return
    if (restoring.current) {
      if (placePosition(node, restoring.current)) {
        restoring.current = null
        setRestoringHistory(false)
      } else if (hasOlder || olderLoading) {
        setRestoringHistory(true)
        setShowJump(true)
        return
      } else {
        node.scrollTop = restoring.current.top
        restoring.current = null
        setRestoringHistory(false)
      }
    } else {
      const position = positions.current.get(conversationId)
      if (position) placePosition(node, position)
    }
    const lastSequence = messages.at(-1)?.sequence ?? 0
    const last = previous.current
    if (!changed && last?.loaded) {
      const additions = messages
        .filter((message) => message.sequence > last.sequence)
        .slice(-3)
        .map((message) => message.id)
      if (additions.length) setArrivalIds(additions)
    }
    previous.current = { loaded: true, sequence: lastSequence }
    savePosition()
  }, [conversationId, messages, loaded, hasOlder, olderLoading, savePosition])
  useEffect(() => {
    if (loaded && restoring.current && !restoring.current.atBottom && older && !olderLoading && !error) void older()
  }, [conversationId, messages, loaded, olderLoading, older, error])
  useEffect(() => {
    if (!arrivalIds.length) return
    const timer = setTimeout(setArrivalIds, 260, [])
    return () => clearTimeout(timer)
  }, [arrivalIds])
  useLayoutEffect(() => {
    const node = ref.current
    const content = timeline.current
    if (!node || !content) return
    const observer = new ResizeObserver(() => {
      if (!node.clientHeight || restoring.current) return
      const position = positions.current.get(target.current)
      if (position) placePosition(node, position)
      savePosition()
    })
    observer.observe(node)
    observer.observe(content)
    return () => observer.disconnect()
  }, [savePosition])
  function jumpToLatest() {
    const node = ref.current
    if (!node) return
    restoring.current = null
    setRestoringHistory(false)
    node.scrollTop = node.scrollHeight
    savePosition()
    node.focus({ preventScroll: true })
  }
  const waiting = !loaded && !error
  return (
    <div className="message-stage">
      <div
        className="message-scroll"
        ref={ref}
        tabIndex={-1}
        aria-label="会话消息"
        aria-busy={waiting || restoringHistory || olderLoading}
        onScroll={savePosition}
      >
        <div ref={timeline} className={cn('message-timeline', restoringHistory && 'is-restoring')}>
          {older && (
            <Button variant="ghost" className="older" disabled={olderLoading} onClick={() => void older()}>
              {olderLoading ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  正在读取
                </>
              ) : (
                '读取更早消息'
              )}
            </Button>
          )}
          {loaded && !items.length && (
            <div className="empty" role="status">
              发送第一条消息
            </div>
          )}
          {items.map((item, index) => {
            const previous = items[index - 1]
            const timeBreak = hasTimeBreak(item.createdAt, previous?.createdAt)
            const previousMessage = previous?.kind === 'message' ? previous.message : undefined
            return (
              <Fragment key={item.id}>
                {timeBreak && (
                  <div className="message-time-separator">
                    <time dateTime={item.createdAt}>{formatChatTime(item.createdAt)}</time>
                  </div>
                )}
                {item.kind === 'message' ? (
                  <MessageItem
                    message={item.message}
                    continued={
                      !timeBreak &&
                      previousMessage?.role === item.message.role &&
                      previousMessage?.botId === item.message.botId &&
                      previousMessage?.authorName === item.message.authorName
                    }
                    arrived={arrivalIds.includes(item.id)}
                    attachments={attachments}
                    tasks={tasks}
                    snapshot={snapshot}
                    refresh={refresh}
                    settings={settings}
                    openTask={openTask}
                  />
                ) : (
                  <PartialReply
                    task={item.task}
                    createdAt={item.createdAt}
                    showAuthor={conversation?.kind === 'group' || item.task.botId !== conversation?.coordinatorId}
                    openTask={openTask}
                  />
                )}
              </Fragment>
            )
          })}
          {live
            .filter(
              (value) =>
                active.has(tasks.find((task) => task.id === value.taskId)?.status ?? '') &&
                !messages.some(
                  (message) =>
                    message.role === 'assistant' &&
                    (message.taskId === value.taskId ||
                      (!!value.runId && tasks.find((task) => task.id === message.taskId)?.runtimeId === value.runId)),
                ),
            )
            .map((value) => {
              const task = tasks.find((item) => item.id === value.taskId)
              if (!task) return null
              const showAuthor = conversation?.kind === 'group' || task.botId !== conversation?.coordinatorId
              return (
                <article
                  className={cn('message message-live', showAuthor && 'with-author')}
                  key={value.taskId}
                  aria-label={`${task.config.name} 正在回复`}
                >
                  {showAuthor && <Avatar name={task.config.name} avatar={task.config.avatar} />}
                  <div className="message-body">
                    <div className={cn('message-bubble', !value.text && 'is-thinking')}>
                      {showAuthor && (
                        <div className="message-meta">
                          <button className="text-link" onClick={() => openTask(task.id)}>
                            {task.config.name}
                          </button>
                          {task.parentTaskId && <small>协作</small>}
                        </div>
                      )}
                      {value.text ? <MessageContent text={value.text} /> : null}
                      {value.tool && (
                        <p className="live-tool-status" role="status">
                          <LoaderCircle size={13} className="spin" />
                          正在使用 {value.tool}
                        </p>
                      )}
                      {!value.text && !value.tool && (
                        <span className="live-typing" role="status" aria-label="正在思考">
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              )
            })}
        </div>
        {(waiting || restoringHistory) && (
          <div className={cn('chat-history-placeholder', restoringHistory && 'restoring-placeholder')} role="status">
            <span className="sr-only">{restoringHistory ? '正在恢复阅读位置' : '正在读取消息'}</span>
            {error ? (
              <>
                <p className="muted">暂时无法恢复阅读位置</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (older) void older()
                    else retry()
                  }}
                >
                  重试读取
                </Button>
              </>
            ) : (
              <div className="chat-history-skeleton" aria-hidden="true">
                {[0, 1, 2].map((row) => (
                  <div key={row}>
                    <span />
                    <div>
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {!loaded && Boolean(error) && (
          <div className="empty">
            <p>消息暂时无法读取</p>
            <Button variant="outline" onClick={retry}>
              重试读取
            </Button>
          </div>
        )}
      </div>
      {showJump && (
        <button className="chat-jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={14} />
          <span>跳到最新</span>
        </button>
      )}
    </div>
  )
}
function PartialReply({
  task,
  createdAt,
  showAuthor,
  openTask,
}: {
  task: Task
  createdAt: string
  showAuthor: boolean
  openTask: (id: string) => void
}) {
  return (
    <article
      className={cn('message message-partial', showAuthor && 'with-author')}
      id={`message-partial:${task.id}`}
      data-message-id={`partial:${task.id}`}
      aria-label={`${task.config.name} 的部分回复，${formatChatTime(createdAt)}`}
    >
      {showAuthor && <Avatar name={task.config.name} avatar={task.config.avatar} />}
      <div className="message-body">
        <div className="message-bubble">
          {showAuthor && (
            <div className="message-meta">
              <strong>{task.config.name}</strong>
            </div>
          )}
          <MessageContent text={task.partialResult!} />
        </div>
        <div className="message-footer">
          <time dateTime={createdAt}>
            {new Date(createdAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </time>
          <Status value={task.status} />
          <CopyButton text={task.partialResult!} />
          <button className="text-link message-task-link" onClick={() => openTask(task.id)}>
            任务
          </button>
        </div>
      </div>
    </article>
  )
}
function MessageItem({
  message,
  continued,
  arrived,
  attachments,
  tasks,
  snapshot,
  refresh,
  settings,
  openTask,
}: {
  message: Message
  continued: boolean
  arrived: boolean
  attachments: Attachment[]
  tasks: Task[]
  snapshot: Snapshot
  refresh: () => Promise<void>
  settings: (tab: string) => void
  openTask: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const action = useAction(refresh)
  const trigger = useRef<HTMLButtonElement>(null)
  const conversation = snapshot.conversations.find((item) => item.id === message.conversationId)
  const scope = conversation?.kind === 'group' ? 'conversation' : 'bot'
  const targetId = scope === 'conversation' ? message.conversationId : conversation?.coordinatorId
  const memory = snapshot.memories.find(
    (item) => item.sourceMessageId === message.id && item.scope === scope && item.targetId === targetId,
  )
  const isUser = message.role === 'user'
  const showAuthor =
    !isUser &&
    message.role !== 'system' &&
    (conversation?.kind === 'group' || (message.botId && message.botId !== conversation?.coordinatorId))
  const messageTasks = tasks.filter((task) => task.sourceMessageId === message.id)
  const childTasks = messageTasks.filter((task) => task.parentTaskId)
  function close() {
    setEditing(false)
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const memoryActions = (
    <span className="message-memory-actions">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={trigger}
            className="message-memory-button"
            aria-label={memory ? '编辑记忆' : '记住这条'}
            aria-expanded={editing}
            onClick={() => setEditing((value) => !value)}
          >
            <Bookmark size={14} fill={memory ? 'currentColor' : 'none'} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{memory ? '编辑记忆' : '记住这条'}</TooltipContent>
      </Tooltip>
      {memory && (
        <button
          className="text-link"
          disabled={Boolean(action.busy)}
          onClick={() =>
            void action.run(memory.id, () =>
              request(`/memories/${memory.id}`, { method: 'DELETE', body: { revision: memory.revision } }),
            )
          }
        >
          撤销记忆
        </button>
      )}
    </span>
  )
  return (
    <article
      className={cn(
        'message',
        isUser && 'from-user',
        message.role === 'system' && 'from-system',
        showAuthor && 'with-author',
        continued && 'message-continued',
        arrived && 'chat-message-arrival',
      )}
      id={`message-${message.id}`}
      data-message-id={message.id}
      aria-label={`${message.authorName}，${formatChatTime(message.createdAt)}`}
    >
      {showAuthor && <Avatar name={message.authorName} avatar={message.avatar} />}
      <div className="message-body">
        <div className="message-bubble">
          {showAuthor && !continued && (
            <div className="message-meta">
              <strong>{message.authorName}</strong>
            </div>
          )}
          <MessageContent text={message.content} />
          {message.attachmentIds.map((id) => {
            const attachment = attachments.find((item) => item.id === id)
            return attachment ? (
              <a className="attachment" key={id} href={attachmentUrl(id)} target="_blank" rel="noreferrer">
                {attachment.mime.startsWith('image/') ? (
                  <img src={attachmentUrl(id)} alt={attachment.name} loading="lazy" />
                ) : (
                  <Paperclip size={16} />
                )}
                <span>{attachment.name}</span>
              </a>
            ) : null
          })}
        </div>
        <div className="message-footer">
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </time>
          {message.source === 'qq' && <small>QQ</small>}
          <CopyButton text={message.content} />
          {memoryActions}
          {message.taskId && (
            <button className="text-link message-task-link" onClick={() => openTask(message.taskId!)}>
              任务
            </button>
          )}
        </div>
        {(editing || Boolean(action.error)) && (
          <div className="message-memory">
            {editing && (
              <div className="task-interaction-card">
                <MemoryEditor
                  item={memory}
                  defaults={{
                    scope,
                    targetId,
                    title: message.content.split('\n')[0].slice(0, 120) || '消息记忆',
                    content: message.content,
                    sourceMessageId: message.id,
                  }}
                  {...{ snapshot, refresh, close }}
                />
              </div>
            )}
            <ErrorText error={action.error} />
          </div>
        )}
        <TaskInteractionCards tasks={messageTasks} {...{ refresh, settings }} />
        {childTasks.map((task) => (
          <CollapsibleSection
            className="collaboration"
            key={task.id}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{task.config.name}</span>
                <Status value={task.status} />
              </span>
            }
            actions={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`查看 ${task.config.name} 的任务详情`}
                onClick={() => openTask(task.id)}
              >
                <ArrowUpRight size={15} />
              </Button>
            }
          >
            <MessageContent text={task.result ?? task.error ?? task.prompt} />
          </CollapsibleSection>
        ))}
      </div>
    </article>
  )
}
type ChatDraft = { text: string; ids: string[]; recipientIds: string[]; mode: 'queue' | 'steer'; version: string }
type PendingChatSubmission = {
  key: string
  draftVersion?: string
  body: { content: string; attachmentIds: string[]; recipientIds: string[]; mode: string; targetTaskId?: string }
}
function readDraft(id: string): ChatDraft {
  const empty: ChatDraft = { text: '', ids: [], recipientIds: [], mode: 'queue', version: 'initial' }
  try {
    const value = JSON.parse(sessionStorage.getItem(`bots.draft.v1:${id}`) ?? 'null') as Partial<ChatDraft> | null
    if (!value || typeof value.text !== 'string' || !Array.isArray(value.ids)) return empty
    return {
      text: value.text,
      ids: value.ids.filter((item): item is string => typeof item === 'string'),
      recipientIds: Array.isArray(value.recipientIds)
        ? value.recipientIds.filter((item): item is string => typeof item === 'string')
        : [],
      mode: value.mode === 'steer' ? 'steer' : 'queue',
      version: typeof value.version === 'string' ? value.version : 'initial',
    }
  } catch {
    return empty
  }
}
function persistChatState(key: string, value: unknown): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
function readPendingMessages(): Record<string, PendingChatSubmission> {
  try {
    const value = JSON.parse(sessionStorage.getItem('bots.pending.v1') ?? '{}') as Record<string, PendingChatSubmission>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, item]) =>
          item &&
          typeof item.key === 'string' &&
          item.body &&
          typeof item.body.content === 'string' &&
          Array.isArray(item.body.attachmentIds) &&
          Array.isArray(item.body.recipientIds),
      ),
    )
  } catch {
    return {}
  }
}
function Composer({
  conversation,
  name,
  bots,
  models,
  defaultModelId,
  timezone,
  configureModels,
  attachments,
  online,
  openSettings,
  refresh,
  busyTasks,
}: {
  conversation: Conversation
  name: string
  bots: Bot[]
  models: ModelConfig[]
  defaultModelId: string | null
  timezone: string
  configureModels: () => void
  attachments: Attachment[]
  online: boolean
  openSettings: (tab: string) => void
  refresh: () => Promise<void>
  busyTasks: Task[]
}) {
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({})
  const latestDrafts = useRef(drafts)
  latestDrafts.current = drafts
  const [errors, setErrors] = useState<Record<string, unknown>>({})
  const [storageWarnings, setStorageWarnings] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [uploading, setUploading] = useState<Record<string, { done: number; total: number }>>({})
  const [stopping, setStopping] = useState<Record<string, boolean>>({})
  const [staleTarget, setStaleTarget] = useState<Record<string, boolean>>({})
  const [sendTargets, setSendTargets] = useState<Task[]>([])
  const [dragging, setDragging] = useState(false)
  const [previewErrors, setPreviewErrors] = useState<string[]>([])
  const [initialPending] = useState(readPendingMessages)
  const pending = useRef(initialPending)
  const sendingLocks = useRef(new Set<string>())
  const uploadingLocks = useRef(new Set<string>())
  const stoppingLocks = useRef(new Set<string>())
  const file = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false)
  const composing = useRef(false)
  const id = conversation.id
  const draft = drafts[id] ?? readDraft(id)
  const error = errors[id]
  const isUploading = Boolean(uploading[id])
  const isSending = Boolean(sending[id])
  const recipientIds = draft.recipientIds.filter((member) => conversation.memberIds.includes(member))
  const targetIds = recipientIds.length ? recipientIds : [conversation.coordinatorId]
  const unavailable = targetIds.some((member) => !bots.find((bot) => bot.id === member)?.enabled)
  const missingModel = targetIds.some((member) => {
    const bot = bots.find((item) => item.id === member)
    const model = models.find((item) => item.kind === 'text' && item.id === (bot?.modelId ?? defaultModelId))
    if (model?.verification?.status !== 'verified') return true
    return (
      !model.hasCredential &&
      !(
        model.provider === 'openai-compatible' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(new URL(model.baseUrl).hostname)
      )
    )
  })
  const runningRoots = busyTasks
    .filter((task) => !task.parentTaskId && task.status !== 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const currentRoot = runningRoots.find((task) => task.status !== 'stopping') ?? runningRoots[0]
  const invalidAttachment = draft.ids.some(
    (attachmentId) =>
      previewErrors.includes(attachmentId) ||
      !attachments.some(
        (attachment) =>
          attachment.id === attachmentId && readableAttachment(attachment.mime) && attachment.conversationId === id,
      ),
  )
  const canSubmit =
    online && !isSending && !isUploading && !invalidAttachment && Boolean(draft.text.trim() || draft.ids.length)
  const canSteer = canSubmit && !pending.current[id]
  const canSend =
    online &&
    !isSending &&
    !isUploading &&
    (Boolean(pending.current[id]) ||
      (!unavailable && !missingModel && !invalidAttachment && Boolean(draft.text.trim() || draft.ids.length)))
  function report(target: string, cause: unknown) {
    setErrors((previous) => ({ ...previous, [target]: cause }))
  }
  function warnStorage(target: string, success: boolean) {
    setStorageWarnings((previous) => ({ ...previous, [target]: !success }))
  }
  function updateDraft(target: string, change: (value: ChatDraft) => ChatDraft) {
    const next = { ...change(latestDrafts.current[target] ?? readDraft(target)), version: crypto.randomUUID() }
    latestDrafts.current = { ...latestDrafts.current, [target]: next }
    setDrafts(latestDrafts.current)
    warnStorage(target, persistChatState(`bots.draft.v1:${target}`, next))
  }
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = '0px'
    const height = Math.min(node.scrollHeight, 220)
    node.style.height = `${height}px`
    node.style.overflowY = node.scrollHeight > 220 ? 'auto' : 'hidden'
  }, [id, draft.text])
  useEffect(() => {
    composing.current = false
    setRecipientMenuOpen(false)
  }, [id])
  async function send(targetTask?: Task) {
    if (!(targetTask ? canSteer : canSend) || sendingLocks.current.has(id) || uploadingLocks.current.has(id)) return
    const target = id
    sendingLocks.current.add(target)
    setSending((previous) => ({ ...previous, [target]: true }))
    report(target, undefined)
    setStaleTarget((previous) => ({ ...previous, [target]: false }))
    textarea.current?.focus({ preventScroll: true })
    const submission = pending.current[target] ?? {
      key: crypto.randomUUID(),
      draftVersion: draft.version,
      body: {
        content: draft.text,
        attachmentIds: draft.ids,
        recipientIds: targetTask
          ? [targetTask.botId]
          : draft.recipientIds.filter((member) => conversation.memberIds.includes(member)),
        mode: targetTask ? 'steer' : 'queue',
        ...(targetTask ? { targetTaskId: targetTask.id } : {}),
      },
    }
    pending.current[target] = submission
    if (!persistChatState('bots.pending.v1', pending.current)) warnStorage(target, false)
    try {
      await request<AcceptedMessage>(`/conversations/${target}/messages`, {
        method: 'POST',
        body: submission.body,
        key: submission.key,
      })
      delete pending.current[target]
      if (!persistChatState('bots.pending.v1', pending.current)) warnStorage(target, false)
      const current = latestDrafts.current[target] ?? readDraft(target)
      if (current.version === submission.draftVersion) updateDraft(target, (value) => ({ ...value, text: '', ids: [] }))
      await refresh()
    } catch (cause) {
      if (
        cause instanceof RequestError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![401, 408].includes(cause.status) &&
        !['outcome-unknown', 'unauthenticated'].includes(cause.code)
      ) {
        delete pending.current[target]
        if (!persistChatState('bots.pending.v1', pending.current)) warnStorage(target, false)
      }
      if (submission.body.mode === 'steer' && cause instanceof RequestError && cause.status === 409)
        setStaleTarget((previous) => ({ ...previous, [target]: true }))
      report(target, cause)
    } finally {
      sendingLocks.current.delete(target)
      setSending((previous) => ({ ...previous, [target]: false }))
    }
  }
  async function upload(files: File[]) {
    if (!files.length || uploadingLocks.current.has(id)) return
    const target = id
    uploadingLocks.current.add(target)
    setUploading((previous) => ({ ...previous, [target]: { done: 0, total: files.length } }))
    report(target, undefined)
    try {
      if ((latestDrafts.current[target] ?? readDraft(target)).ids.length + files.length > 10)
        throw new Error('每条消息最多 10 个附件')
      for (const item of files) {
        if (!readableAttachment(item.type))
          throw new Error(`支持 PNG、JPEG、WebP、GIF、UTF-8 文本和 JSON：${item.name}`)
        if (!item.size || item.size > 20 * 1024 * 1024) throw new Error(`附件须为1字节至20MiB：${item.name}`)
      }
      for (const [index, item] of files.entries()) {
        const form = new FormData()
        form.set('file', item)
        form.set('conversationId', target)
        const attachment = await request<Attachment>('/attachments', { method: 'POST', body: form })
        updateDraft(target, (value) => ({ ...value, ids: [...value.ids, attachment.id] }))
        setUploading((previous) => ({ ...previous, [target]: { done: index + 1, total: files.length } }))
      }
    } catch (cause) {
      report(target, cause)
    } finally {
      try {
        await refresh()
      } catch (cause) {
        report(target, cause)
      }
      uploadingLocks.current.delete(target)
      setUploading((previous) => {
        const next = { ...previous }
        delete next[target]
        return next
      })
    }
  }
  async function stop() {
    if (!online || stoppingLocks.current.has(id) || !currentRoot) return
    const target = id
    const rootId = currentRoot.id
    stoppingLocks.current.add(target)
    setStopping((previous) => ({ ...previous, [target]: true }))
    report(target, undefined)
    try {
      await request(`/tasks/${rootId}/stop`, { method: 'POST', body: {} })
      await refresh()
    } catch (cause) {
      report(target, cause)
    } finally {
      stoppingLocks.current.delete(target)
      setStopping((previous) => ({ ...previous, [target]: false }))
    }
  }
  return (
    <div className="composer-wrap">
      {conversation.sequence === 0 && !draft.text && !draft.ids.length && !missingModel && !unavailable && (
        <div className="bot-setup-actions">
          {[
            ['连接 Pi meme', '帮我连接 Pi meme'],
            ['接入 QQ', '帮我接入 QQ 机器人'],
            ['调整外观', '帮我调整外观'],
          ].map(([label, prompt]) => (
            <Button
              key={label}
              variant="outline"
              size="sm"
              onClick={() => {
                updateDraft(id, (value) => ({ ...value, text: prompt }))
                textarea.current?.focus()
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      <div id="chat-composer-feedback">
        <ErrorText error={error} />
        {staleTarget[id] && (
          <Button variant="outline" size="sm" disabled={!canSend} onClick={() => void send()}>
            改为排队发送
          </Button>
        )}
        {storageWarnings[id] && (
          <p className="error" role="status">
            浏览器暂时无法保存草稿或发送状态，请保持此页打开。
          </p>
        )}
        {unavailable && <p className="error">所选 Bot 已停用，请先启用。</p>}
        {missingModel && (
          <p className="composer-model-notice">
            请先连通对话模型。
            <button
              className="text-link"
              onClick={() => {
                const bot = bots.find(
                  (item) =>
                    targetIds.includes(item.id) &&
                    !models.some(
                      (model) =>
                        model.id === (item.modelId ?? defaultModelId) && model.verification?.status === 'verified',
                    ),
                )
                const modelId = bot?.modelId ?? defaultModelId
                if (modelId) sessionStorage.setItem('bots.model.focus', modelId)
                configureModels()
              }}
            >
              检查模型
            </button>
          </p>
        )}
        {invalidAttachment && !isUploading && <p className="error">部分附件已不可用，请移除后再发送。</p>}
      </div>
      <div
        className={cn('composer', dragging && 'is-dragging')}
        aria-busy={isUploading || isSending}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
            setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void upload(Array.from(event.dataTransfer.files))
        }}
      >
        {draft.ids.length > 0 && (
          <div className="draft-attachments">
            {draft.ids.map((attachmentId) => (
              <span key={attachmentId}>
                {imageMimeTypes.includes(
                  attachments.find((attachment) => attachment.id === attachmentId)?.mime ?? '',
                ) && (
                  <img
                    className="draft-attachment-preview"
                    src={attachmentUrl(attachmentId)}
                    alt={attachments.find((attachment) => attachment.id === attachmentId)?.name ?? '图片附件'}
                    onError={() =>
                      setPreviewErrors((values) => (values.includes(attachmentId) ? values : [...values, attachmentId]))
                    }
                  />
                )}
                <span className="draft-attachment-name">
                  {attachments.find((attachment) => attachment.id === attachmentId)?.name ??
                    (isUploading ? '正在准备附件' : '附件已不可用')}
                </span>
                <button
                  type="button"
                  aria-label="移除附件"
                  onClick={() =>
                    updateDraft(id, (value) => ({ ...value, ids: value.ids.filter((item) => item !== attachmentId) }))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <Textarea
          ref={textarea}
          aria-label="消息"
          aria-describedby={
            Boolean(error) || storageWarnings[id] || unavailable || missingModel || invalidAttachment
              ? 'chat-composer-feedback'
              : undefined
          }
          placeholder={`发送给 ${name}`}
          value={draft.text}
          rows={1}
          maxLength={32000}
          onChange={(event) => updateDraft(id, (value) => ({ ...value, text: event.target.value }))}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((item) => item.type.startsWith('image/'))
            if (images.length) {
              event.preventDefault()
              void upload(images)
            }
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.altKey &&
              !event.nativeEvent.isComposing &&
              !composing.current &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-actions">
          <div className="inline-actions">
            <input
              ref={file}
              type="file"
              accept={attachmentAccept}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void upload(files)
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isUploading ? '正在上传附件' : '添加'}
                  disabled={!online || isUploading}
                >
                  {isUploading ? <LoaderCircle size={17} className="spin" /> : <Plus size={19} />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bot-dropdown-content" side="top" align="start" sideOffset={8}>
                <DropdownMenuItem onSelect={() => file.current?.click()}>
                  <Paperclip size={14} />
                  添加图片或附件
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    persistChatState('bots.schedule.new', {
                      conversationId: conversation.id,
                      botId: targetIds.length === 1 ? targetIds[0] : conversation.coordinatorId,
                      timezone,
                      notification: 'web',
                    })
                    openSettings('schedules')
                  }}
                >
                  新建定时任务
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openSettings('memories')}>记忆</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {conversation.kind === 'group' && (
              <div className="recipient-menu">
                <Popover open={recipientMenuOpen} onOpenChange={setRecipientMenuOpen}>
                  <PopoverTrigger asChild>
                    <button type="button" className="recipient-menu-trigger">
                      @成员
                      {draft.recipientIds.some((member) => conversation.memberIds.includes(member)) && (
                        <span className="recipient-count">
                          {draft.recipientIds.filter((member) => conversation.memberIds.includes(member)).length}
                        </span>
                      )}
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="bot-recipient-content"
                    side="top"
                    align="start"
                    collisionPadding={12}
                    aria-label="选择接收成员"
                    onEscapeKeyDown={(event) => {
                      if (event.isComposing || event.keyCode === 229) event.preventDefault()
                    }}
                  >
                    {conversation.memberIds.map((member) => {
                      const bot = bots.find((value) => value.id === member)
                      return (
                        <Check
                          key={member}
                          checked={draft.recipientIds.includes(member)}
                          onChange={(checked) =>
                            updateDraft(id, (value) => ({
                              ...value,
                              recipientIds: checked
                                ? [...value.recipientIds, member]
                                : value.recipientIds.filter((item) => item !== member),
                            }))
                          }
                        >
                          {bot?.name ?? member}
                        </Check>
                      )
                    })}
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>
          <div className="inline-actions">
            {currentRoot && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={stopping[id] ? '正在停止本轮任务' : `停止 ${currentRoot.config.name} 本轮任务`}
                disabled={!online || stopping[id] || currentRoot.status === 'stopping'}
                onClick={() => void stop()}
              >
                {stopping[id] ? <LoaderCircle size={15} className="spin" /> : <Square size={15} />}
              </Button>
            )}
            <Button
              size="icon-sm"
              aria-label={pending.current[id] ? '核对本次发送' : isSending ? '正在发送消息' : '发送消息'}
              disabled={!canSend}
              onClick={() => void send()}
            >
              {isSending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}
            </Button>
            {runningRoots.some((task) => task.status === 'running') && !pending.current[id] && (
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open) setSendTargets(runningRoots.filter((task) => task.status === 'running'))
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="选择发送方式" disabled={!canSteer}>
                    <ChevronDown size={13} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="bot-dropdown-content" side="top" align="end" sideOffset={8}>
                  <DropdownMenuItem disabled={!canSend} onSelect={() => void send()}>
                    排队发送
                  </DropdownMenuItem>
                  {sendTargets.map((task) => (
                    <DropdownMenuItem
                      key={task.id}
                      disabled={!busyTasks.some((current) => current.id === task.id && current.status === 'running')}
                      onSelect={() => void send(task)}
                    >
                      补充 {task.config.name} 当前任务
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
      {isUploading && (
        <p className="composer-transfer-status" role="status">
          正在上传附件 {uploading[id].done}/{uploading[id].total}
        </p>
      )}
      {pending.current[id] && !isSending && (
        <div className="inline-actions pending-message">
          <p className="muted">发送结果尚未确认。再次点击发送会核对同一次请求。</p>
          <blockquote>
            {pending.current[id].body.content || `${pending.current[id].body.attachmentIds.length} 个附件`}
          </blockquote>
          <Button
            variant="ghost"
            onClick={() => {
              if (!confirm('请先查看会话是否已有本次消息。放弃核对后再次发送可能造成重复，继续？')) return
              delete pending.current[id]
              if (!persistChatState('bots.pending.v1', pending.current)) warnStorage(id, false)
              report(id, undefined)
            }}
          >
            放弃本次核对
          </Button>
        </div>
      )}
    </div>
  )
}
function NewGroup({ bots, close, done }: { bots: Bot[]; close: () => void; done: (id: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [coordinator, setCoordinator] = useState('')
  const [collaboration, setCollaboration] = useState(true)
  const [saving, setSaving] = useState(false)
  const dirty = Boolean(name || members.length || !collaboration)
  function leave() {
    if (saving) return
    if (!dirty || confirm('群组尚未创建，放弃当前填写内容？')) close()
  }
  return (
    <Modal title="创建群组" onClose={leave}>
      <Form
        submit="创建群组"
        onCancel={leave}
        onSubmit={async () => {
          if (members.length < 2) throw new Error('请选择至少两位 Bot。')
          setSaving(true)
          try {
            const group = await request<Conversation>('/conversations', {
              method: 'POST',
              body: {
                name:
                  name.trim() ||
                  members
                    .map((id) => bots.find((bot) => bot.id === id)?.name ?? '')
                    .join('、')
                    .slice(0, 120),
                kind: 'group',
                memberIds: members,
                coordinatorId: coordinator || members[0],
                collaborationEnabled: collaboration,
              },
            })
            await done(group.id)
          } finally {
            setSaving(false)
          }
        }}
      >
        <Field label="群组名称">
          <Input
            autoFocus
            value={name}
            maxLength={120}
            placeholder="默认使用成员名称"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="成员">
          <div className="group-member-choices">
            {bots
              .filter((bot) => bot.enabled)
              .map((bot) => (
                <Check
                  key={bot.id}
                  checked={members.includes(bot.id)}
                  onChange={(checked) => {
                    setMembers((values) => (checked ? [...values, bot.id] : values.filter((id) => id !== bot.id)))
                    if (checked && !coordinator) setCoordinator(bot.id)
                    if (!checked && coordinator === bot.id) setCoordinator(members.find((id) => id !== bot.id) ?? '')
                  }}
                >
                  <Avatar name={bot.name} avatar={bot.avatar} />
                  <span>{bot.name}</span>
                </Check>
              ))}
            {bots.filter((bot) => bot.enabled).length < 2 && <p className="muted">需要至少两位已启用的 Bot。</p>}
          </div>
        </Field>
        <Check checked={collaboration} onChange={setCollaboration}>
          允许成员在本群协作
        </Check>
        <CollapsibleSection
          className="advanced"
          title={`协调者：${bots.find((bot) => bot.id === coordinator)?.name ?? '首位成员'}`}
        >
          <Field label="协调者">
            <Select value={coordinator} onChange={setCoordinator}>
              <option value="">选择协调者</option>
              {members.map((id) => (
                <option key={id} value={id}>
                  {bots.find((bot) => bot.id === id)?.name}
                </option>
              ))}
            </Select>
          </Field>
        </CollapsibleSection>
      </Form>
    </Modal>
  )
}
function ConversationDetails({
  conversation,
  snapshot,
  refresh,
  onDirtyChange,
  onSavingChange,
  done,
}: PageProps & {
  conversation: Conversation
  onDirtyChange: (dirty: boolean) => void
  onSavingChange: (saving: boolean) => void
  done: () => void
}) {
  const storageKey = `bots.group-editor.v1:${conversation.id}`
  const [stored] = useState<Partial<Conversation>>(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<Conversation>) : {}
    } catch {
      return {}
    }
  })
  const [baseRevision, setBaseRevision] = useState(stored.revision ?? conversation.revision)
  const [name, setName] = useState(stored.name ?? conversation.name)
  const [members, setMembers] = useState(stored.memberIds ?? conversation.memberIds)
  const [coordinator, setCoordinator] = useState(stored.coordinatorId ?? conversation.coordinatorId)
  const [collaboration, setCollaboration] = useState(
    stored.collaborationEnabled ?? conversation.collaborationEnabled === true,
  )
  const [storageError, setStorageError] = useState(false)
  const dirty =
    name !== conversation.name ||
    coordinator !== conversation.coordinatorId ||
    collaboration !== (conversation.collaborationEnabled === true) ||
    JSON.stringify(members) !== JSON.stringify(conversation.memberIds)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    if (dirty)
      setStorageError(
        !persistChatState(storageKey, {
          revision: baseRevision,
          name,
          memberIds: members,
          coordinatorId: coordinator,
          collaborationEnabled: collaboration,
        }),
      )
  }, [storageKey, baseRevision, name, members, coordinator, collaboration, dirty])
  return (
    <>
      <Form
        onCancel={() => {
          if (!dirty || confirm('放弃尚未保存的群组修改？')) {
            sessionStorage.removeItem(storageKey)
            done()
          }
        }}
        onSubmit={async () => {
          const removed = conversation.memberIds.filter((id) => !members.includes(id))
          if (
            snapshot.tasks.some(
              (task) =>
                task.conversationId === conversation.id && removed.includes(task.botId) && active.has(task.status),
            ) &&
            !confirm('将停止被移除成员的当前任务，再保存成员变更。继续？')
          )
            return
          onSavingChange(true)
          try {
            const saved = await request<Conversation>(`/conversations/${conversation.id}`, {
              method: 'PATCH',
              body: {
                revision: baseRevision,
                name,
                memberIds: members,
                coordinatorId: coordinator,
                collaborationEnabled: collaboration,
                removalMode: 'stop',
              },
            })
            setBaseRevision(saved.revision)
            sessionStorage.removeItem(storageKey)
            await refresh().catch(() => {})
            done()
          } finally {
            onSavingChange(false)
          }
        }}
      >
        {storageError && (
          <p className="error" role="alert">
            浏览器暂时无法保存群组草稿，请保持编辑页打开。
          </p>
        )}
        {baseRevision !== conversation.revision && (
          <p className="error" role="status">
            群组已更新，保存将核对原修订版本。
          </p>
        )}
        <Field label="名称">
          <Input value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        {conversation.kind === 'group' && (
          <>
            <Field label="成员">
              <div className="choice-list">
                {snapshot.bots.map((b) => (
                  <Check
                    key={b.id}
                    checked={members.includes(b.id)}
                    onChange={(checked) => {
                      setMembers((values) => (checked ? [...values, b.id] : values.filter((id) => id !== b.id)))
                      if (!checked && coordinator === b.id) setCoordinator(members.find((id) => id !== b.id) ?? '')
                      if (checked && !coordinator) setCoordinator(b.id)
                    }}
                  >
                    {b.name}
                  </Check>
                ))}
              </div>
            </Field>
            <Check checked={collaboration} onChange={setCollaboration}>
              允许成员在本群协作
            </Check>
            <Field label="协调者">
              <Select value={coordinator} onChange={setCoordinator}>
                {members.map((id) => (
                  <option key={id} value={id}>
                    {snapshot.bots.find((b) => b.id === id)?.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </Form>
    </>
  )
}
type PendingHostInteraction = {
  source: { agentId: string; name: string }
  request: {
    id: string
    method: string
    title?: string
    message?: string
    options?: string[]
    questions?: { id: string; question: string; options?: { label: string }[] }[]
  }
}
function HostInteractions({
  taskId,
  revision,
  refresh,
}: {
  taskId: string
  revision: number
  refresh: () => Promise<void>
}) {
  const [items, setItems] = useState<PendingHostInteraction[]>([])
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    const controller = new AbortController()
    void request<{ snapshot?: { pendingInteractions?: PendingHostInteraction[] } }>(`/delegations/${taskId}`, {
      signal: controller.signal,
    })
      .then((data) => setItems(data.snapshot?.pendingInteractions ?? []))
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause)
      })
    return () => controller.abort()
  }, [taskId, revision])
  return (
    <>
      <ErrorText error={error} />
      {items.map((item) => (
        <HostInteraction key={item.request.id} item={item} taskId={taskId} refresh={refresh} />
      ))}
    </>
  )
}
function HostInteraction({
  item,
  taskId,
  refresh,
}: {
  item: PendingHostInteraction
  taskId: string
  refresh: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const req = item.request
  const confirmAction = useAction(refresh)
  async function respond(response: unknown) {
    await request(`/delegations/${taskId}/interaction`, {
      method: 'POST',
      body: { requestId: req.id, agentId: item.source.agentId, response },
    })
    await refresh()
  }
  return (
    <div className="record">
      <h3>{req.title ?? item.source.name}</h3>
      {req.message && <p>{req.message}</p>}
      <ErrorText error={confirmAction.error} />
      {req.method === 'confirm' ? (
        <div className="inline-actions">
          <Button
            disabled={!!confirmAction.busy}
            onClick={() => void confirmAction.run('confirm', () => respond({ confirmed: true }))}
          >
            确认
          </Button>
          <Button
            variant="outline"
            disabled={!!confirmAction.busy}
            onClick={() => void confirmAction.run('reject', () => respond({ confirmed: false }))}
          >
            拒绝
          </Button>
        </div>
      ) : (
        <Form
          submit="提交答复"
          onSubmit={() =>
            respond(
              req.method === 'questions'
                ? {
                    answers: (req.questions ?? []).map((question) => ({
                      id: question.id,
                      value: answers[question.id] ?? null,
                    })),
                  }
                : { value },
            )
          }
        >
          {req.method === 'questions' ? (
            (req.questions ?? []).map((question) => (
              <Field key={question.id} label={question.question}>
                {question.options ? (
                  <Select
                    value={answers[question.id] ?? ''}
                    onChange={(selected) => setAnswers((previous) => ({ ...previous, [question.id]: selected }))}
                  >
                    <option value="">跳过此题</option>
                    {question.options.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={answers[question.id] ?? ''}
                    onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))}
                  />
                )}
              </Field>
            ))
          ) : req.method === 'select' ? (
            <Field label="选择">
              <Select value={value} onChange={setValue} required>
                <option value="">请选择</option>
                {req.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="答复">
              <Textarea required value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
          )}
        </Form>
      )}
    </div>
  )
}
function TaskDetails({
  task,
  tasks,
  settings,
  refresh,
  close,
  navigate,
}: {
  task?: Task
  tasks: Task[]
  settings: (tab: string) => void
  refresh: () => Promise<void>
  close: () => void
  navigate: PageProps['navigate']
}) {
  const action = useAction(refresh)
  const [artifactPath, setArtifactPath] = useState('')
  return (
    <Modal title={task ? `${task.config.name} · 任务` : '任务不可用'} onClose={close}>
      {task ? (
        <>
          <div className="inline-actions">
            <Status value={task.status} />
            <span className="muted">{date(task.createdAt)}</span>
          </div>
          <p className="task-prompt">{task.prompt}</p>
          <ErrorText error={task.error} />
          <TaskInteractionCards tasks={[task]} {...{ refresh, settings }} />
          {task.result && <MessageContent text={task.result} />}
          {task.hostDelegation && (
            <div className="record">
              <h3>Pi meme 执行</h3>
              <p>
                {task.hostDelegation.hostId} / {task.hostDelegation.projectId}
              </p>
              <p>会话：{task.hostDelegation.sessionId ?? '待确认'}</p>
              <Status value={task.hostDelegation.status} />
              {task.status === 'waiting' && (
                <HostInteractions taskId={task.id} revision={task.revision} refresh={refresh} />
              )}
              {task.status === 'unknown' && task.hostDelegation.operationId && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void action.run('reconcile', () =>
                      request(`/delegations/${task.id}/reconcile`, { method: 'POST', body: {} }),
                    )
                  }
                >
                  核对 Pi meme 回执
                </Button>
              )}
              <Form
                submit="获取产物"
                onSubmit={async () => {
                  await request(`/delegations/${task.id}/attachments`, { method: 'POST', body: { path: artifactPath } })
                  await refresh()
                  setArtifactPath('')
                }}
              >
                <Field label="Pi meme 产物路径">
                  <Input required value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} />
                </Field>
              </Form>
            </div>
          )}
          {tasks
            .filter((t) => t.parentTaskId === task.id)
            .map((child) => (
              <div className="task-row" key={child.id}>
                <span>{child.config.name}</span>
                <Status value={child.status} />
              </div>
            ))}
          {task.usage && (
            <p className="muted">
              输入 {task.usage.input} · 输出 {task.usage.output} · 费用{' '}
              {task.usage.cost === null ? '未知' : `$${task.usage.cost}`}
            </p>
          )}
          <ErrorText error={action.error} />
          <div className="form-actions">
            <Button
              variant="ghost"
              onClick={() => {
                navigate('chats', task.conversationId)
                close()
              }}
            >
              返回来源会话
            </Button>
            {active.has(task.status) ? (
              <Button
                variant="outline"
                disabled={!!action.busy}
                onClick={() =>
                  void action.run('stop', () => request(`/tasks/${task.id}/stop`, { method: 'POST', body: {} }))
                }
              >
                停止本次任务与子协作
              </Button>
            ) : (
              ['failed', 'stopped', 'blocked'].includes(task.status) && (
                <Button
                  disabled={!!action.busy}
                  onClick={() =>
                    void action.run('retry', () => request(`/tasks/${task.id}/attempts`, { method: 'POST', body: {} }))
                  }
                >
                  再次执行
                </Button>
              )
            )}
          </div>
        </>
      ) : (
        <Empty>任务不存在或已经不可访问</Empty>
      )}
    </Modal>
  )
}
