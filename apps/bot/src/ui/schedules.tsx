import { useState } from 'react'
import { Plus } from 'lucide-react'
import { request } from '../client/api'
import type { Schedule } from '../shared/types'
import {
  Button,
  Check,
  date,
  Empty,
  ErrorText,
  Field,
  Form,
  Input,
  Modal,
  Select,
  Status,
  Textarea,
  useAction,
} from './common'
import type { PageProps } from './common'
import { motionTransition } from './motion'

export function Schedules({ snapshot, refresh, navigate }: PageProps) {
  const [editing, setEditing] = useState<Schedule | null | undefined>()
  const [expanded, setExpanded] = useState('')
  const action = useAction(refresh)
  return (
    <section className="full-page">
      <div className="section-heading">
        <h1>计划</h1>
        <Button variant="outline" onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
          <Plus size={15} />
          新建计划
        </Button>
      </div>
      <ErrorText error={action.error} />
      {snapshot.schedules.length ? (
        snapshot.schedules.map((s) => (
          <div className="record schedule" key={s.id}>
            <div className="record-heading">
              <div>
                <h2>{s.name}</h2>
                <p className="muted">
                  {snapshot.bots.find((b) => b.id === s.botId)?.name} ·{' '}
                  {s.enabled ? `下一次 ${date(s.nextRunAt)}` : '已暂停'} · {s.timezone}
                </p>
              </div>
              <Button variant="outline" onClick={() => motionTransition('bot-modal', () => setEditing(s))}>
                编辑
              </Button>
            </div>
            <p>{s.prompt}</p>
            <div className="inline-actions">
              <Button
                variant="outline"
                disabled={!!action.busy}
                onClick={() =>
                  void action.run(s.id, () =>
                    request(`/schedules/${s.id}/${s.enabled ? 'pause' : 'resume'}`, {
                      method: 'POST',
                      body: { revision: s.revision },
                    }),
                  )
                }
              >
                {s.enabled ? '暂停未来运行' : '恢复计划'}
              </Button>
              <Button
                variant="ghost"
                disabled={!!action.busy}
                onClick={() =>
                  void action.run(s.id, () => request(`/schedules/${s.id}/run`, { method: 'POST', body: {} }))
                }
              >
                立即运行
              </Button>
              <Button variant="ghost" onClick={() => setExpanded((value) => (value === s.id ? '' : s.id))}>
                运行记录
              </Button>
              <Button variant="ghost" onClick={() => navigate('chats', s.conversationId)}>
                来源会话
              </Button>
              <Button
                variant="ghost"
                className="danger"
                onClick={() => {
                  if (confirm(`删除计划“${s.name}”？当前运行需要单独停止。`))
                    void action.run(s.id, () =>
                      request(`/schedules/${s.id}?revision=${s.revision}`, { method: 'DELETE' }),
                    )
                }}
              >
                删除
              </Button>
            </div>
            {expanded === s.id && (
              <div className="run-list">
                {snapshot.scheduleRuns
                  .filter((r) => r.scheduleId === s.id)
                  .map((r) => (
                    <div className="task-row" key={r.id}>
                      <span>{date(r.dueAt)}</span>
                      <Status value={r.status} />
                      {r.status === 'running' && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void action.run(r.id, () =>
                              request(`/schedules/${s.id}/runs/${r.id}/stop`, { method: 'POST', body: {} }),
                            )
                          }
                        >
                          停止本次运行
                        </Button>
                      )}
                      {r.error && <ErrorText error={r.error} />}
                    </div>
                  ))}
                {!snapshot.scheduleRuns.some((r) => r.scheduleId === s.id) && <p className="muted">尚无运行记录</p>}
              </div>
            )}
          </div>
        ))
      ) : (
        <Empty action={<Button onClick={() => motionTransition('bot-modal', () => setEditing(null))}>新建计划</Button>}>
          安排一项 Bot 工作
        </Empty>
      )}
      {editing !== undefined && (
        <ScheduleEditor
          schedule={editing ?? undefined}
          snapshot={snapshot}
          close={() => motionTransition('bot-modal', () => setEditing(undefined))}
          refresh={refresh}
        />
      )}
    </section>
  )
}
function ScheduleEditor({
  schedule,
  snapshot,
  close,
  refresh,
}: {
  schedule?: Schedule
  snapshot: PageProps['snapshot']
  close: () => void
  refresh: () => Promise<void>
}) {
  const [name, setName] = useState(schedule?.name ?? '')
  const [conversationId, setConversation] = useState(schedule?.conversationId ?? '')
  const [botId, setBot] = useState(schedule?.botId ?? '')
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')
  const [kind, setKind] = useState(schedule?.kind ?? 'once')
  const [timezone, setTimezone] = useState(schedule?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [at, setAt] = useState(
    schedule?.at
      ? new Date(new Date(schedule.at).getTime() - new Date(schedule.at).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : '',
  )
  const [time, setTime] = useState(schedule?.time ?? '09:00')
  const [weekdays, setWeekdays] = useState(schedule?.weekdays ?? [1])
  const [notification, setNotification] = useState(schedule?.notification ?? 'web')
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState<unknown>()
  const value = () => ({
    name,
    conversationId,
    botId,
    prompt,
    kind,
    timezone,
    at: at ? new Date(at).toISOString() : '',
    time,
    weekdays,
    notification,
    enabled: schedule?.enabled ?? true,
  })
  return (
    <Modal title={schedule ? '编辑计划' : '新建计划'} onClose={close}>
      <Form
        onSubmit={async () => {
          await request(schedule ? `/schedules/${schedule.id}` : '/schedules', {
            method: schedule ? 'PATCH' : 'POST',
            body: { ...value(), revision: schedule?.revision },
          })
          await refresh()
          close()
        }}
      >
        <Field label="名称">
          <Input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="来源会话">
            <Select required value={conversationId} onChange={setConversation}>
              <option value="">选择会话</option>
              {snapshot.conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="执行 Bot">
            <Select required value={botId} onChange={setBot}>
              <option value="">选择角色</option>
              {snapshot.bots
                .filter((b) => b.enabled)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label="执行内容">
          <Textarea required maxLength={40000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <Field label="规则">
          <Select value={kind} onChange={(v) => setKind(v as Schedule['kind'])}>
            <option value="once">单次</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </Select>
        </Field>
        {kind === 'once' ? (
          <Field label="执行时刻（当前设备时区）">
            <Input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        ) : (
          <>
            <div className="form-grid">
              <Field label="时间">
                <Input required type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
              <Field label="IANA 时区">
                <Input required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </Field>
            </div>
            {kind === 'weekly' && (
              <div className="weekday-list">
                {['日', '一', '二', '三', '四', '五', '六'].map((label, index) => (
                  <Check
                    key={index}
                    checked={weekdays.includes(index)}
                    onChange={(checked) =>
                      setWeekdays((values) => (checked ? [...values, index] : values.filter((v) => v !== index)))
                    }
                  >
                    周{label}
                  </Check>
                ))}
              </div>
            )}
          </>
        )}
        <Field label="通知渠道">
          <Select value={notification} onChange={(v) => setNotification(v as Schedule['notification'])}>
            <option value="web">Web</option>
            <option value="qq">QQ</option>
          </Select>
        </Field>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setPreviewError(undefined)
            void request<{ nextRunAt: string }>('/schedules/preview', { method: 'POST', body: value() })
              .then((result) => setPreview(date(result.nextRunAt)))
              .catch(setPreviewError)
          }}
        >
          预览下次运行
        </Button>
        {preview && <p role="status">下次运行：{preview}</p>}
        <ErrorText error={previewError} />
      </Form>
    </Modal>
  )
}
