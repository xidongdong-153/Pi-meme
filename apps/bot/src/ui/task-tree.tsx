import { LoaderCircle, X } from 'lucide-react'
import { request } from '../client/api'
import type { Task } from '../shared/types'
import { Button, ErrorText, Status, useAction } from './common'

export function TaskTree({
  tasks,
  openTask,
  refresh,
}: {
  tasks: Task[]
  openTask: (id: string) => void
  refresh: () => Promise<void>
}) {
  const roots = tasks
    .filter((task) => !tasks.some((parent) => parent.id === task.parentTaskId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <ul className="conversation-task-tree">
      {roots.map((task) => (
        <TaskBranch key={task.id} {...{ task, tasks, openTask, refresh }} ancestors={[]} />
      ))}
    </ul>
  )
}

function TaskBranch({
  task,
  tasks,
  openTask,
  refresh,
  ancestors,
}: {
  task: Task
  tasks: Task[]
  openTask: (id: string) => void
  refresh: () => Promise<void>
  ancestors: string[]
}) {
  const action = useAction(refresh)
  if (ancestors.includes(task.id)) return null
  const children = tasks.filter((item) => item.parentTaskId === task.id)
  const parent = tasks.find((item) => item.id === task.parentTaskId)
  return (
    <li>
      <div className="task-tree-row">
        <button className="task-row" onClick={() => openTask(task.id)}>
          <span>
            {task.config.name}
            {parent && <small>由 {parent.config.name} 邀请</small>}
          </span>
          <Status value={task.status} />
        </button>
        {task.status === 'queued' && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`取消 ${task.config.name} 排队任务`}
            disabled={Boolean(action.busy)}
            onClick={() =>
              void action.run('cancel', () => request(`/tasks/${task.id}/stop`, { method: 'POST', body: {} }))
            }
          >
            {action.busy ? <LoaderCircle size={13} className="spin" /> : <X size={13} />}
          </Button>
        )}
      </div>
      <ErrorText error={action.error} />
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <TaskBranch
              key={child.id}
              task={child}
              {...{ tasks, openTask, refresh }}
              ancestors={[...ancestors, task.id]}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
