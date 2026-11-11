import { useRef, useState } from 'react'
import { CheckCircle2, LoaderCircle, MessageCircleQuestion } from 'lucide-react'
import { request } from '../client/api'
import type { Task, TaskInteraction, TaskResponse } from '../shared/types'
import { Button, ErrorText, Select, Textarea } from './common'

export function TaskInteractionCards({
  tasks,
  refresh,
  settings,
}: {
  tasks: Task[]
  refresh: () => Promise<void>
  settings: (tab: string) => void
}) {
  return tasks.map((task) => (
    <div key={task.id} className="task-inline-interactions">
      {task.completionAction?.status === 'failed' && (
        <div className="task-interaction-card" role="alert">
          <p>{task.completionAction.error}</p>
        </div>
      )}
      {task.completionAction?.status === 'cancelled' && (
        <div className="task-interaction-card" role="status">
          <p>回复后的配置更改已取消</p>
        </div>
      )}
      {task.interactions
        ?.filter((interaction) => interaction.status === 'pending')
        .map((interaction) => (
          <InteractionCard key={interaction.id} {...{ task, interaction, refresh }} />
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
                ? '连接 Pi meme'
                : task.blocker.capability === 'web'
                  ? '联网设置'
                  : '连接模型'}
            </Button>
          )}
        </div>
      )}
    </div>
  ))
}

export function InteractionCard({
  task,
  interaction,
  refresh,
}: {
  task: Task
  interaction: TaskInteraction
  refresh: () => Promise<void>
}) {
  const [answer, setAnswer] = useState('')
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
        {question ? <MessageCircleQuestion size={17} /> : <CheckCircle2 size={17} />}
        <strong>{task.config.name}</strong>
      </div>
      <p>{interaction.question}</p>
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
        <div className="inline-actions">
          <Button size="sm" disabled={busy} onClick={() => void respond({ decision: 'approve' })}>
            {busy && <LoaderCircle size={13} className="spin" />}确认
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond({ decision: 'deny' })}>
            取消
          </Button>
        </div>
      )}
      <ErrorText error={error} />
    </section>
  )
}
