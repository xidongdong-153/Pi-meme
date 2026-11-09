import { useRef, useState } from 'react'
import { Bot as BotIcon, ChevronUp, LogOut, Plus, Search, Settings, Users, X } from 'lucide-react'
import type { Bot, Message, Snapshot } from '../shared/types'
import { Avatar, BrandMark, Button, DrawerClose, Input } from './common'
import { Menu } from './menu'
import { cn } from './utils'

export function BotSidebar({
  snapshot,
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
  selectedId?: string
  messages: Record<string, Message[]>
  openBot: (bot: Bot) => void
  openGroup: (id: string) => void
  createBot: () => void
  createGroup: () => void
  openSettings: (tab?: string) => void
  logout: () => void
}) {
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const lead = snapshot.bots.find((bot) => bot.id === snapshot.qq.defaultBotId) ?? snapshot.bots[0]
  const conversations = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]))
  const entries = [
    ...snapshot.bots
      .filter((bot) => query || bot.id !== lead?.id)
      .map((bot) => {
        const conversation = bot.webConversationId ? conversations.get(bot.webConversationId) : undefined
        return {
          id: bot.id,
          conversationId: bot.webConversationId,
          name: bot.name,
          avatar: bot.avatar,
          description: bot.enabled ? bot.description || '开始聊天' : '已停用',
          updatedAt: conversation?.updatedAt ?? bot.updatedAt,
          pinned: conversation?.pinned ?? false,
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
        bot: undefined,
        group,
      })),
  ]
    .filter((entry) => entry.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
  function preview(id: string | undefined, fallback: string) {
    return id ? messages[id]?.at(-1)?.content.replace(/\s+/g, ' ').trim() || fallback : fallback
  }
  return (
    <aside className="list-pane bot-sidebar" aria-label="Bot 与群组">
      <div className="sidebar-heading">
        <span className="sidebar-brand">
          <BrandMark />
          <strong>Pi Bot</strong>
        </span>
        <div className="inline-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label={searching ? '关闭搜索' : '搜索 Bot 与群组'}
            onClick={() => {
              setSearching((value) => !value)
              setSearch('')
              if (!searching) requestAnimationFrame(() => searchInput.current?.focus())
            }}
          >
            {searching ? <X size={18} /> : <Search size={18} />}
          </Button>
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
      {searching && (
        <div className="sidebar-search">
          <Search size={15} aria-hidden="true" />
          <Input
            ref={searchInput}
            aria-label="搜索 Bot 与群组"
            placeholder="搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearch('')
                setSearching(false)
              }
            }}
          />
        </div>
      )}
      <div className="list-scroll">
        {lead && !query && (
          <div className="lead-bot-wrap">
            <button
              className={cn('lead-bot', selectedId === lead.webConversationId && 'selected')}
              aria-label={`与 ${lead.name} 聊天`}
              aria-current={selectedId === lead.webConversationId ? 'page' : undefined}
              onClick={() => openBot(lead)}
            >
              <Avatar name={lead.name} avatar={lead.avatar} />
              <strong>{lead.name}</strong>
            </button>
          </div>
        )}
        {entries.map((entry) => (
          <button
            key={entry.id}
            className={cn('list-item bot-list-item', entry.conversationId === selectedId && 'selected')}
            aria-current={entry.conversationId === selectedId ? 'page' : undefined}
            onClick={() => (entry.bot ? openBot(entry.bot) : openGroup(entry.id))}
          >
            {entry.group ? (
              <span className="group-avatar" aria-hidden="true">
                {entry.group.memberIds.slice(0, 3).map((id) => {
                  const bot = snapshot.bots.find((item) => item.id === id)
                  return <Avatar key={id} name={bot?.name ?? ''} avatar={bot?.avatar} />
                })}
                {!entry.group.memberIds.length && <Users size={24} />}
              </span>
            ) : (
              <Avatar name={entry.name} avatar={entry.avatar} />
            )}
            <span>
              <strong>{entry.name}</strong>
              <small>{preview(entry.conversationId, entry.description)}</small>
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
    </aside>
  )
}
