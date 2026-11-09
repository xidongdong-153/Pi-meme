import type { PiSessionSummary } from '@pi-meme/contracts/sessions'
import type { SidebarSource } from './sidebar-source'

export function activityTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

function nextRunText(task: NonNullable<PiSessionSummary['scheduledTask']>) {
  if (task.status === 'paused') return '定时任务已暂停'
  if (task.status === 'completed') return '定时任务已结束'
  if (!task.nextRunAt) return '暂无后续安排'
  try {
    const next = new Date(task.nextRunAt)
    const parts = (date: Date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat('zh-CN', {
          timeZone: task.timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value]),
      )
    const target = parts(next)
    const today = parts(new Date())
    const day = (value: typeof target) => Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day))
    const difference = (day(target) - day(today)) / 86400000
    const date =
      difference === 0
        ? '今天'
        : difference === 1
          ? '明天'
          : `${target.year === today.year ? '' : `${target.year} 年 `}${Number(target.month)} 月 ${Number(target.day)} 日`
    const zone = task.timeZone === new Intl.DateTimeFormat().resolvedOptions().timeZone ? '' : ` · ${task.timeZone}`
    return `下次运行：${date} ${target.hour}:${target.minute}${zone}`
  } catch {
    return '运行时间不可用'
  }
}

export function SessionDetails({
  session,
  source,
  projectName,
}: {
  session: PiSessionSummary
  source?: SidebarSource
  projectName?: string
}) {
  const activity = session.completedAt ?? session.modified
  const timestamp = Date.parse(activity)
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm [&>dt]:text-muted-foreground [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:select-text">
      <dt>状态</dt>
      <dd>
        {source && !source.connected
          ? '远程未连接，状态待同步'
          : session.isPaused
            ? '已暂停'
            : session.needsInput
              ? '等待用户输入'
              : session.running
                ? '运行中'
                : '未运行'}
      </dd>
      <dt>最近活动</dt>
      <dd>
        <time dateTime={activity}>
          {Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '时间不可用'}
          {activityTime(activity) && ` · ${activityTime(activity)}`}
        </time>
      </dd>
      <dt>来源</dt>
      <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {source ? source.description : '本机'}
        {source && !source.connected && ' · 未连接'}
      </dd>
      <dt>项目</dt>
      <dd className="[overflow-wrap:anywhere]">
        {projectName && <div>{projectName}</div>}
        {session.sourceProjectCwd ?? session.cwd}
      </dd>
      {session.scheduledTask && (
        <>
          <dt>定时安排</dt>
          <dd>
            <div>{session.scheduledTask.name}</div>
            <div>{source && !source.connected ? '远程未连接，安排待同步' : nextRunText(session.scheduledTask)}</div>
          </dd>
        </>
      )}
      {session.parentSessionPath && (
        <>
          <dt>父会话</dt>
          <dd className="[overflow-wrap:anywhere]">{session.parentSessionPath}</dd>
        </>
      )}
    </dl>
  )
}
