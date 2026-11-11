import { useDeferredValue, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Bot as BotIcon, ChevronUp, LogOut, Pin, Plus, Search, Settings, Users, X } from 'lucide-react'
import type { Bot, Message, Snapshot, Task } from '../shared/types'
import { Avatar, BrandMark, Button, DrawerClose, GroupAvatar, Input } from './common'
import { formatChatTime } from './chat-time'
import { Menu } from './menu'
import { cn } from './utils'

export function BotSidebar({
  snapshot,
  open,
  selectedId,
  messages,
  openBot,
  openGroup,
  createBot,
  createGroup,
  openSettings,
  logout,
}: {
  snapshot: Snapshot
  open: boolean
  selectedId?: string
  messages: Record<string, Message[]>
  openBot: (bot: Bot) => void
  openGroup: (id: string) => void
  createBot: () => void
  createGroup: () => void
  openSettings: (tab?: string) => void
  logout: () => void
}) {
  const [search, setSearch] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem('bots.sidebar-width.v1'))
      return value >= 220 && value <= 420 ? value : 280
    } catch {
      return 280
    }
  })
  const [resizing, setResizing] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const maximumWidth = viewportWidth <= 640 ? 420 : Math.max(220, Math.min(420, viewportWidth - 440))
  const visibleWidth = Math.min(width, maximumWidth)
  const drag = useRef<{ x: number; width: number } | null>(null)
  function resize(value: number) {
    const next = Math.max(220, Math.min(maximumWidth, value))
    setWidth(next)
    try {
      localStorage.setItem('bots.sidebar-width.v1', String(next))
    } catch {
      // The current window can still keep its layout when storage is unavailable.
    }
  }
  const query = useDeferredValue(search.trim().toLocaleLowerCase())
  const lead =
    snapshot.bots.find((bot) => bot.id === snapshot.modelSettings.defaultAssistantId && bot.enabled) ??
    [...snapshot.bots].filter((bot) => bot.enabled).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  const conversations = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]))
  const latestTasks = new Map<string, Task>()
  for (const task of snapshot.tasks) {
    if (!task.publicReply) continue
    const previous = latestTasks.get(task.conversationId)
    if (!previous || task.createdAt > previous.createdAt) latestTasks.set(task.conversationId, task)
  }
  function preview(id: string | undefined, fallback: string) {
    if (!id) return fallback
    const task = latestTasks.get(id)
    const message = messages[id]?.at(-1)
    if (task?.status === 'waiting') return '等待你的确认'
    if (task?.status === 'running') return '正在回复…'
    if (task?.status === 'queued') return '等待处理…'
    if (task?.status === 'stopping') return '正在停止…'
    const output = task?.result ?? task?.partialResult
    if (output && (!message || (task?.finishedAt ?? task?.updatedAt ?? '') > message.createdAt)) return output
    if (task && (!message || task.createdAt > message.createdAt)) return task.prompt
    return message?.content || (message?.attachmentIds.length ? '附件' : fallback)
  }
  const entries = [
    ...snapshot.bots.map((bot) => {
      const conversation = bot.webConversationId ? conversations.get(bot.webConversationId) : undefined
      return {
        id: bot.id,
        conversationId: bot.webConversationId,
        name: bot.name,
        avatar: bot.avatar,
        description: bot.enabled ? bot.description || '开始聊天' : '已停用',
        updatedAt: conversation?.updatedAt ?? bot.updatedAt,
        pinned: conversation?.pinned ?? false,
        preview: preview(bot.webConversationId, bot.enabled ? bot.description || '开始聊天' : '已停用'),
        bot,
        group: undefined,
      }
    }),
    ...snapshot.conversations
      .filter((conversation) => conversation.kind === 'group' && !conversation.archived)
      .map((group) => ({
        id: group.id,
        conversationId: group.id,
        name: group.name,
        avatar: '',
        description: group.memberIds
          .map((id) => snapshot.bots.find((bot) => bot.id === id)?.name)
          .filter(Boolean)
          .join('、'),
        updatedAt: group.updatedAt,
        pinned: group.pinned,
        preview: preview(group.id, '开始群聊'),
        bot: undefined,
        group,
      })),
  ]
    .filter((entry) => `${entry.name} ${entry.description} ${entry.preview}`.toLocaleLowerCase().includes(query))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.id === lead?.id) - Number(a.id === lead?.id) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
  return (
    <aside
      id="bot-list"
      className={cn('list-pane bot-sidebar', resizing && 'is-resizing')}
      style={{ '--sidebar-width': `${visibleWidth}px` } as CSSProperties}
      data-state={open ? 'open' : 'closed'}
      aria-label="Bot 与群组"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="bot-sidebar-content">
        <div className="sidebar-heading">
          <span className="sidebar-brand">Pi Bot</span>
          <div className="inline-actions">
            <Menu
              label="创建"
              items={[
                { label: '创建 Bot', icon: BotIcon, onSelect: createBot },
                { label: '创建群组', icon: Users, onSelect: createGroup },
              ]}
            >
              <Plus size={20} strokeWidth={1.7} />
            </Menu>
            <DrawerClose />
          </div>
        </div>
        <div className="sidebar-search">
          <Search size={15} aria-hidden="true" />
          <Input
            ref={searchInput}
            type="search"
            aria-label="搜索 Bot 与群组"
            placeholder="搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                setSearch('')
              }
            }}
          />
          {search && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="清空搜索"
              onClick={() => {
                setSearch('')
                searchInput.current?.focus()
              }}
            >
              <X size={14} />
            </Button>
          )}
        </div>
        <div className="list-scroll">
          {entries.map((entry) => (
            <button
              key={entry.id}
              className={cn('list-item bot-list-item', entry.conversationId === selectedId && 'selected')}
              aria-label={`${entry.name}${entry.id === snapshot.modelSettings.defaultAssistantId ? '，默认助理' : ''}`}
              aria-current={entry.conversationId === selectedId ? 'page' : undefined}
              onClick={() => (entry.bot ? openBot(entry.bot) : openGroup(entry.id))}
            >
              {entry.group ? (
                <GroupAvatar memberIds={entry.group.memberIds} bots={snapshot.bots} />
              ) : (
                <Avatar name={entry.name} avatar={entry.avatar} />
              )}
              <span className="bot-list-copy">
                <span className="bot-list-title">
                  <strong>{entry.name}</strong>
                  <time dateTime={entry.updatedAt}>{formatChatTime(entry.updatedAt, true)}</time>
                </span>
                <span className="bot-list-preview">
                  <small
                    className={cn(latestTasks.get(entry.conversationId ?? '')?.status === 'running' && 'is-active')}
                  >
                    {entry.preview
                      .slice(0, 500)
                      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                      .replace(/\*\*|__|`{1,3}|^#{1,6}\s/g, '')
                      .replace(/\s+/g, ' ')
                      .trim()}
                  </small>
                  {entry.pinned && <Pin size={11} aria-label="已置顶" />}
                </span>
              </span>
            </button>
          ))}
          {query && !entries.length && <p className="sidebar-empty">没有找到 Bot 或群组</p>}
          {!snapshot.bots.length && !query && (
            <div className="sidebar-first-bot">
              <BotIcon size={28} strokeWidth={1.4} />
              <Button variant="outline" onClick={createBot}>
                <Plus size={15} />
                创建 Bot
              </Button>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          <Menu
            label="个人菜单"
            side="top"
            className="account-menu"
            items={[
              { label: '设置', icon: Settings, onSelect: () => openSettings() },
              { label: '退出登录', icon: LogOut, onSelect: logout },
            ]}
          >
            <span className="account-avatar">
              <BrandMark />
            </span>
            <span>个人空间</span>
            <ChevronUp size={15} />
          </Menu>
        </div>
      </div>
      <div
        className="sidebar-resize"
        role="separator"
        tabIndex={open ? 0 : -1}
        aria-label="调整 Bot 列表宽度"
        aria-controls="bot-list"
        aria-orientation="vertical"
        aria-valuemin={220}
        aria-valuemax={maximumWidth}
        aria-valuenow={visibleWidth}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          drag.current = { x: event.clientX, width: visibleWidth }
          event.currentTarget.setPointerCapture(event.pointerId)
          setResizing(true)
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setWidth(Math.max(220, Math.min(maximumWidth, drag.current.width + event.clientX - drag.current.x)))
        }}
        onPointerUp={(event) => {
          if (!drag.current) return
          resize(drag.current.width + event.clientX - drag.current.x)
          drag.current = null
          setResizing(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          if (drag.current) setWidth(drag.current.width)
          drag.current = null
          setResizing(false)
        }}
        onLostPointerCapture={() => {
          drag.current = null
          setResizing(false)
        }}
        onDoubleClick={() => resize(280)}
        onKeyDown={(event) => {
          const values: Record<string, number> = {
            ArrowLeft: visibleWidth - 16,
            ArrowRight: visibleWidth + 16,
            Home: 220,
            End: maximumWidth,
          }
          if (Object.hasOwn(values, event.key)) {
            event.preventDefault()
            resize(values[event.key])
          }
        }}
      />
    </aside>
  )
}
