import { ChevronRight, MoreHorizontal, Pencil, Users } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { request } from '../client/api'
import type { Bot, Conversation, Snapshot } from '../shared/types'
import { Avatar, Button, Check, date, ErrorText, Status, useAction } from './common'

const capabilityNames: Record<string, string> = {
  collaborate: 'Bot 协作',
  hosts: 'Host 任务',
  images: '生图',
  web: '公开网页',
  schedules: '定时任务',
}

export function ConversationOverview({
  conversation,
  bot,
  snapshot,
  refresh,
  edit,
  tasks,
  settings,
  openBot,
  removed,
}: {
  conversation: Conversation
  bot?: Bot
  snapshot: Snapshot
  refresh: () => Promise<void>
  edit: () => void
  tasks: () => void
  settings: (tab: string) => void
  openBot: (bot: Bot) => void
  removed: () => void
}) {
  const action = useAction(refresh)
  const modelId = bot?.modelId ?? snapshot.modelSettings.defaultModelId
  const model = snapshot.models.find((item) => item.id === modelId)
  const memories = snapshot.memories.filter(
    (memory) =>
      memory.scope === 'owner' ||
      (memory.scope === 'bot' && memory.targetId === bot?.id) ||
      (memory.scope === 'conversation' && memory.targetId === conversation.id),
  )
  const schedules = snapshot.schedules.filter(
    (schedule) => schedule.conversationId === conversation.id || (bot && schedule.botId === bot.id),
  )
  const taskCount = snapshot.tasks.filter((task) => task.conversationId === conversation.id).length
  async function changeConversation(values: Record<string, unknown>) {
    await request(`/conversations/${conversation.id}`, {
      method: 'PATCH',
      body: { revision: conversation.revision, ...values },
    })
  }
  return (
    <div className="conversation-overview">
      <div className="ds-details-identity">
        {bot ? <Avatar name={bot.name} avatar={bot.avatar} /> : <Users size={38} strokeWidth={1.3} />}
        <h2>{bot?.name ?? conversation.name}</h2>
        {bot?.description && <p>{bot.description}</p>}
        <div className="inline-actions">
          <Button variant="outline" size="sm" onClick={edit}>
            <Pencil size={13} />
            {bot ? '编辑 Bot' : '编辑群组'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="更多会话操作">
                <MoreHorizontal size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="conversation-actions-menu" side="bottom" align="end" sideOffset={6}>
              <DropdownMenuItem
                disabled={Boolean(action.busy)}
                onSelect={() => void action.run('pin', () => changeConversation({ pinned: !conversation.pinned }))}
              >
                {conversation.pinned ? '取消置顶' : '置顶会话'}
              </DropdownMenuItem>
              {!bot && (
                <>
                  <DropdownMenuItem
                    disabled={Boolean(action.busy)}
                    onSelect={() =>
                      void action.run('archive', async () => {
                        await changeConversation({ archived: !conversation.archived })
                        removed()
                      })
                    }
                  >
                    {conversation.archived ? '恢复群组' : '归档群组'}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ErrorText error={action.error} />
      {bot ? (
        <section className="ds-details-section">
          <h3>对话模型</h3>
          <button className="ds-detail-row" onClick={() => settings('models')}>
            <span>
              {model?.name ?? '尚未配置'}
              {!bot.modelId && <small>跟随默认</small>}
            </span>
            <ChevronRight size={14} />
          </button>
        </section>
      ) : (
        <section className="ds-details-section">
          <h3>成员 · {conversation.memberIds.length}</h3>
          {conversation.memberIds.map((id) => {
            const member = snapshot.bots.find((item) => item.id === id)
            return member ? (
              <button className="ds-detail-row" key={id} onClick={() => openBot(member)}>
                <Avatar name={member.name} avatar={member.avatar} />
                <span>{member.name}</span>
                {id === conversation.coordinatorId && <small>协调者</small>}
                <ChevronRight size={14} />
              </button>
            ) : null
          })}
          <Check
            checked={conversation.collaborationEnabled === true}
            onChange={(enabled) =>
              void action.run('collaboration', () => changeConversation({ collaborationEnabled: enabled }))
            }
          >
            允许成员在本群协作
          </Check>
        </section>
      )}
      {bot && (
        <section className="ds-details-section">
          <h3>能力</h3>
          <div className="detail-capabilities">
            <span>对话</span>
            {bot.capabilities.map((capability) => (
              <span key={capability}>{capabilityNames[capability]}</span>
            ))}
          </div>
        </section>
      )}
      <section className="ds-details-section">
        <button className="ds-detail-row detail-section-link" onClick={() => settings('memories')}>
          <h3>记忆</h3>
          <span>{memories.length}</span>
          <ChevronRight size={14} />
        </button>
        {memories.slice(0, 3).map((memory) => (
          <div className="detail-memory" key={memory.id}>
            <strong>{memory.title}</strong>
            <p>{memory.content}</p>
          </div>
        ))}
      </section>
      <section className="ds-details-section">
        <button className="ds-detail-row detail-section-link" onClick={() => settings('schedules')}>
          <h3>定时任务</h3>
          <span>{schedules.length}</span>
          <ChevronRight size={14} />
        </button>
        {schedules.slice(0, 3).map((schedule) => (
          <div className="ds-detail-row" key={schedule.id}>
            <span>
              {schedule.name}
              <small>{schedule.enabled ? date(schedule.nextRunAt) : '已暂停'}</small>
            </span>
            <Status value={schedule.enabled ? 'queued' : 'disabled'} />
          </div>
        ))}
      </section>
      <section className="ds-details-section">
        <button className="ds-detail-row detail-section-link" onClick={tasks}>
          <h3>任务记录</h3>
          <span>{taskCount}</span>
          <ChevronRight size={14} />
        </button>
      </section>
    </div>
  )
}
