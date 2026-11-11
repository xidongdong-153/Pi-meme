import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { request } from '../client/api'
import type { Schedule } from '../shared/types'
import {
  Button,
  Check,
  CollapsibleSection,
  date,
  Empty,
  ErrorText,
  Field,
  Form,
  Input,
  Select,
  Status,
  Textarea,
  useAction,
} from './common'
import type { PageProps } from './common'

export function Schedules({
  snapshot,
  refresh,
  navigate,
  onDirtyChange,
  onSavingChange,
}: PageProps & { onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void }) {
  const [prefill] = useState<Partial<Schedule> | undefined>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem('bots.schedule.new') ?? 'null') as Partial<Schedule> | null
      return value && typeof value.conversationId === 'string' ? value : undefined
    } catch {
      return undefined
    }
  })
  const [editing, setEditing] = useState<Schedule | null | undefined>(prefill ? null : undefined)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState('')
  const action = useAction(refresh)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (prefill) sessionStorage.removeItem('bots.schedule.new')
  }, [prefill])
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    onSavingChange?.(saving)
  }, [saving, onSavingChange])
  function edit(schedule: Schedule | null) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditing(schedule)
  }
  function close() {
    setEditing(undefined)
    setDirty(false)
    requestAnimationFrame(() => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
    })
  }
  if (editing !== undefined)
    return (
      <section className="full-page">
        <div className="section-heading">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="返回定时任务"
            disabled={saving}
            onClick={() => {
              if (!dirty || confirm('放弃尚未保存的定时任务修改？')) close()
            }}
          >
            <ArrowLeft size={16} />
          </Button>
          <h1>{editing ? '编辑定时任务' : '新建定时任务'}</h1>
        </div>
        <ScheduleEditor
          schedule={editing ?? undefined}
          defaults={prefill}
          {...{ snapshot, refresh, close }}
          onDirtyChange={setDirty}
          onSavingChange={setSaving}
        />
      </section>
    )
  return (
    <section className="full-page">
      <div className="section-heading">
        <h1>定时任务</h1>
        <Button variant="outline" onClick={() => edit(null)}>
          <Plus size={15} />
          新建定时任务
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
              <Button variant="outline" onClick={() => edit(s)}>
                编辑
              </Button>
            </div>
            <p>{s.prompt}</p>
            <div className="inline-actions">
              <Button
                variant="outline"
                disabled={action.busy === s.id}
                onClick={() =>
                  void action.run(s.id, () =>
                    request(`/schedules/${s.id}/${s.enabled ? 'pause' : 'resume'}`, {
                      method: 'POST',
                      body: { revision: s.revision },
                    }),
                  )
                }
              >
                {s.enabled ? '暂停未来运行' : '恢复定时任务'}
              </Button>
              <Button
                variant="ghost"
                disabled={action.busy === s.id}
                onClick={() =>
                  void action.run(s.id, () => request(`/schedules/${s.id}/run`, { method: 'POST', body: {} }))
                }
              >
                立即运行
              </Button>
              <Button variant="ghost" onClick={() => navigate('chats', s.conversationId)}>
                来源会话
              </Button>
              <Button
                variant="ghost"
                className="danger"
                onClick={() => {
                  if (confirm(`删除定时任务“${s.name}”？请先停止或等待当前运行结束。`))
                    void action.run(s.id, () =>
                      request(`/schedules/${s.id}?revision=${s.revision}`, { method: 'DELETE' }),
                    )
                }}
              >
                删除
              </Button>
            </div>
            <CollapsibleSection
              title="运行记录"
              className="mt-4"
              open={expanded === s.id}
              onOpenChange={(open) => setExpanded(open ? s.id : '')}
            >
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
            </CollapsibleSection>
          </div>
        ))
      ) : (
        <Empty action={<Button onClick={() => edit(null)}>新建定时任务</Button>}>安排一项 Bot 工作</Empty>
      )}
    </section>
  )
}
function ScheduleEditor({
  schedule,
  snapshot,
  close,
  refresh,
  defaults,
  onDirtyChange,
  onSavingChange,
}: {
  schedule?: Schedule
  snapshot: PageProps['snapshot']
  close: () => void
  refresh: () => Promise<void>
  defaults?: Partial<Schedule>
  onDirtyChange: (dirty: boolean) => void
  onSavingChange: (saving: boolean) => void
}) {
  const [initial] = useState(() => ({ ...defaults, ...schedule }))
  const [name, setName] = useState(
    schedule?.name ??
      snapshot.conversations.find((item) => item.id === initial.conversationId)?.name.slice(0, 80) ??
      '',
  )
  const [conversationId, setConversation] = useState(initial.conversationId ?? '')
  const [botId, setBot] = useState(initial.botId ?? '')
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')
  const [kind, setKind] = useState(schedule?.kind ?? 'once')
  const [timezone, setTimezone] = useState(initial.timezone ?? snapshot.settings.timezone)
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
  const [dirty, setDirty] = useState(false)
  const previewLock = useRef(false)
  const previewVersion = useRef(0)
  const [previewing, setPreviewing] = useState(false)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  function changed() {
    setDirty(true)
    previewVersion.current++
    setPreview('')
    setPreviewError(undefined)
  }
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
    <div onChange={changed}>
      <Form
        submit="保存"
        onCancel={() => {
          if (!dirty || confirm('放弃尚未保存的定时任务修改？')) close()
        }}
        onSubmit={async () => {
          onSavingChange(true)
          try {
            await request(schedule ? `/schedules/${schedule.id}` : '/schedules', {
              method: schedule ? 'PATCH' : 'POST',
              body: { ...value(), revision: schedule?.revision },
            })
            await refresh().catch(() => {})
            close()
          } finally {
            onSavingChange(false)
          }
        }}
      >
        <Field label="名称">
          <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="来源会话">
            <Select
              required
              value={conversationId}
              onChange={(id) => {
                setConversation(id)
                setBot(snapshot.conversations.find((item) => item.id === id)?.coordinatorId ?? '')
                changed()
              }}
            >
              <option value="">选择会话</option>
              {snapshot.conversations
                .filter((item) => !item.archived)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="执行 Bot">
            <Select
              required
              value={botId}
              onChange={(id) => {
                setBot(id)
                changed()
              }}
            >
              <option value="">选择角色</option>
              {snapshot.bots
                .filter(
                  (b) =>
                    b.enabled &&
                    snapshot.conversations.find((item) => item.id === conversationId)?.memberIds.includes(b.id),
                )
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label="执行内容">
          <Textarea required maxLength={32000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <Field label="规则">
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v as Schedule['kind'])
              changed()
            }}
          >
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
                <Input required maxLength={100} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
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
          <Select
            value={notification}
            onChange={(v) => {
              setNotification(v as Schedule['notification'])
              changed()
            }}
          >
            <option value="web">Web</option>
            <option value="qq">QQ</option>
          </Select>
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={previewing}
          onClick={() => {
            if (previewLock.current) return
            previewLock.current = true
            const version = previewVersion.current
            setPreviewing(true)
            setPreviewError(undefined)
            void Promise.resolve()
              .then(() => request<{ nextRunAt: string }>('/schedules/preview', { method: 'POST', body: value() }))
              .then((result) => {
                if (previewVersion.current === version) setPreview(date(result.nextRunAt))
              })
              .catch((cause) => {
                if (previewVersion.current === version) setPreviewError(cause)
              })
              .finally(() => {
                previewLock.current = false
                setPreviewing(false)
              })
          }}
        >
          预览下次运行
        </Button>
        {preview && <p role="status">下次执行 {preview}</p>}
        <ErrorText error={previewError} />
      </Form>
    </div>
  )
}
