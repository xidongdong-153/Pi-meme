import { useRef, useState } from 'react'
import { CheckCircle2, LoaderCircle, MessageCircleQuestion, ShieldCheck } from 'lucide-react'
import { request } from '../client/api'
import type { Snapshot, Task, TaskInteraction, TaskResponse } from '../shared/types'
import { Button, Check, ErrorText, Select, Textarea } from './common'

const capabilityLabels: Record<string, string> = {
  collaborate: 'Bot 协作',
  hosts: 'Host 任务',
  images: '生图',
  web: '公开网页',
  schedules: '定时任务',
}
const proposalLabels: Record<string, string> = {
  'create-bot': '创建 Bot',
  'create-group': '创建群组',
  'create-schedule': '创建定时任务',
  remember: '保存记忆',
}
const fieldLabels: Record<string, string> = {
  name: '名称',
  description: '简介',
  instructions: '职责',
  modelId: '模型',
  memberIds: '成员',
  coordinatorId: '协调者',
  collaborationEnabled: '群内协作',
  botId: '执行 Bot',
  prompt: '执行内容',
  enabled: '启用',
  kind: '频率',
  timezone: '时区',
  at: '下次执行',
  time: '时间',
  weekdays: '星期',
  notification: '通知',
  scope: '范围',
  targetId: '目标',
  title: '标题',
  content: '内容',
}
const valueLabels: Record<string, string> = {
  once: '一次',
  daily: '每天',
  weekly: '每周',
  web: 'Web',
  qq: 'QQ',
  owner: '全局',
  bot: 'Bot',
  conversation: '当前会话',
}

function displayValue(key: string, value: unknown, snapshot: Snapshot, timezone?: unknown): string {
  if (value === null || value === undefined || value === '') return key === 'modelId' ? '跟随默认模型' : '—'
  if (typeof value === 'boolean') return value ? '允许' : '关闭'
  if (Array.isArray(value)) return value.map((item) => displayValue(key, item, snapshot)).join('、')
  const label = String(value)
  if (key === 'at') {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: typeof timezone === 'string' ? timezone : undefined,
      }).format(new Date(label))
    } catch {
      return label
    }
  }
  if (['memberIds', 'coordinatorId', 'botId', 'targetId'].includes(key))
    return (
      snapshot.bots.find((bot) => bot.id === label)?.name ??
      snapshot.conversations.find((item) => item.id === label)?.name ??
      label
    )
  if (key === 'modelId') return snapshot.models.find((model) => model.id === label)?.name ?? label
  return valueLabels[label] ?? label
}

export function TaskInteractionCards({
  tasks,
  snapshot,
  refresh,
  settings,
}: {
  tasks: Task[]
  snapshot: Snapshot
  refresh: () => Promise<void>
  settings: (tab: string) => void
}) {
  return tasks.map((task) => (
    <div key={task.id} className="task-inline-interactions">
      {task.interactions
        ?.filter((interaction) => interaction.status === 'pending')
        .map((interaction) => (
          <InteractionCard key={interaction.id} {...{ task, interaction, snapshot, refresh }} />
        ))}
      {(task.status === 'blocked' || task.blocker) && (
        <div className="task-interaction-card task-blocker" role="status">
          <p>{task.blocker?.message ?? task.error ?? '任务暂时无法继续'}</p>
          {task.blocker && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                settings(
                  task.blocker?.capability === 'hosts'
                    ? 'connections'
                    : task.blocker?.capability === 'web'
                      ? 'tools'
                      : 'models',
                )
              }
            >
              {task.blocker.capability === 'hosts'
                ? '配置 Host'
                : task.blocker.capability === 'web'
                  ? '打开设置'
                  : '配置模型'}
            </Button>
          )}
        </div>
      )}
    </div>
  ))
}

function InteractionCard({
  task,
  interaction,
  snapshot,
  refresh,
}: {
  task: Task
  interaction: TaskInteraction
  snapshot: Snapshot
  refresh: () => Promise<void>
}) {
  const [answer, setAnswer] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const lock = useRef(false)
  const question = interaction.kind === 'question'
  async function respond(value: Omit<TaskResponse, 'interactionId' | 'revision'>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(undefined)
    try {
      await request(`/tasks/${task.id}/responses`, {
        method: 'POST',
        body: { interactionId: interaction.id, revision: interaction.revision, ...value },
      })
      await refresh()
    } catch (cause) {
      setError(cause)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <section className="task-interaction-card" aria-label={question ? '等待你的答复' : '等待你的确认'} aria-busy={busy}>
      <div className="task-interaction-heading">
        {question ? (
          <MessageCircleQuestion size={17} />
        ) : interaction.kind === 'permission' ? (
          <ShieldCheck size={17} />
        ) : (
          <CheckCircle2 size={17} />
        )}
        <strong>
          {question
            ? task.config.name
            : interaction.kind === 'permission'
              ? `${task.config.name} · ${capabilityLabels[interaction.capability ?? ''] ?? '申请权限'}`
              : `${task.config.name} · ${proposalLabels[interaction.proposal?.kind ?? ''] ?? '确认草稿'}`}
        </strong>
      </div>
      <p>{interaction.question}</p>
      {interaction.targetRefs && (
        <p className="muted">
          {[
            interaction.targetRefs.hostId &&
              (snapshot.hosts.find((host) => host.id === interaction.targetRefs?.hostId)?.name ??
                interaction.targetRefs.hostId),
            interaction.targetRefs.projectId,
            interaction.targetRefs.botId &&
              (snapshot.bots.find((bot) => bot.id === interaction.targetRefs?.botId)?.name ??
                interaction.targetRefs.botId),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {interaction.proposal && (
        <dl className="task-proposal-values">
          {Object.entries(interaction.proposal.value).map(([key, value]) => (
            <div key={key}>
              <dt>{fieldLabels[key] ?? key}</dt>
              <dd>{displayValue(key, value, snapshot, interaction.proposal?.value.timezone)}</dd>
            </div>
          ))}
        </dl>
      )}
      {question ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void respond({ answer: answer.trim() })
          }}
        >
          {interaction.options?.length ? (
            <Select value={answer} onChange={setAnswer} required disabled={busy} aria-label="答复">
              <option value="">选择答复</option>
              {interaction.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Textarea
              aria-label="答复"
              value={answer}
              maxLength={8000}
              required
              rows={2}
              disabled={busy}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <Button type="submit" size="sm" disabled={busy || !answer.trim()}>
            {busy && <LoaderCircle size={13} className="spin" />}提交答复
          </Button>
        </form>
      ) : (
        <>
          {interaction.kind === 'permission' && (
            <Check checked={remember} onChange={setRemember}>
              今后允许此 Bot 使用同一权限
            </Check>
          )}
          <div className="inline-actions">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void respond({
                  decision: 'approve',
                  ...(interaction.kind === 'permission' ? { scope: remember ? 'bot' : 'task' } : {}),
                })
              }
            >
              {busy && <LoaderCircle size={13} className="spin" />}
              {interaction.kind === 'proposal' ? '确认并保存' : remember ? '始终允许' : '仅本任务允许'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond({ decision: 'deny' })}>
              拒绝
            </Button>
          </div>
        </>
      )}
      <ErrorText error={error} />
    </section>
  )
}
