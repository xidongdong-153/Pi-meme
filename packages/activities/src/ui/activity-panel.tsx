import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, ChevronDown, Copy, ExternalLink, RefreshCw, Square } from 'lucide-react'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import { isLiveServiceActivity, type ServiceActivity } from '@pi-meme/contracts/service-activity'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ActivityState, ActivityStore } from './activity-store'

const labels: Record<ServiceActivity['status'], string> = {
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  exited: '已退出',
  failed: '失败',
}

export function activityAddress(value: string, local: boolean): { url: string; openable: boolean } | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    const hostname = url.hostname.toLowerCase()
    const loopback =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.startsWith('127.') ||
      hostname === '[::1]' ||
      hostname.startsWith('[::ffff:7f') ||
      hostname === '0.0.0.0' ||
      hostname === '[::]'
    return { url: url.href, openable: local || !loopback }
  } catch {
    return undefined
  }
}

function elapsed(activity: ServiceActivity, now: number) {
  const seconds = Math.max(
    0,
    Math.floor(((activity.endedAt ? Date.parse(activity.endedAt) : now) - Date.parse(activity.startedAt)) / 1000),
  )
  if (!Number.isFinite(seconds)) return '时长未知'
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(setCopied, 1500, false)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="inline-flex shrink-0 items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={error || label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setError('')
          } catch (cause) {
            setError(`复制失败：${String(cause)}`)
          }
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      {error && (
        <span role="alert" className="text-destructive">
          复制失败
        </span>
      )}
    </span>
  )
}

function ActivityCard({
  activity,
  store,
  session,
  state,
  local,
  now,
}: {
  activity: ServiceActivity
  store: ActivityStore
  session: SessionRef
  state: ActivityState
  local: boolean
  now: number
}) {
  const [logsOpen, setLogsOpen] = useState(false)
  const [follow, setFollow] = useState(true)
  const output = useRef<HTMLPreElement>(null)
  const live = isLiveServiceActivity(activity)
  const pending = state.stopping.includes(activity.serviceId)
  const logs = state.logs[activity.serviceId]
  const error = state.errors[activity.serviceId] || activity.lastError
  const stopping = pending || (activity.status === 'stopping' && !error)
  useEffect(() => {
    store.expandLogs(session, activity.serviceId, logsOpen)
    return () => store.expandLogs(session, activity.serviceId, false)
  }, [store, session.hostId, session.sessionId, activity.serviceId, logsOpen, state.connected, live])
  useEffect(() => {
    if (follow && logsOpen && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [follow, logsOpen, logs?.sequence])
  return (
    <article aria-label={`服务：${activity.name}`} className="space-y-2 rounded-lg bg-secondary/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 break-words font-medium">{activity.name}</h3>
        <span
          role="status"
          className={cn('shrink-0 text-muted-foreground', activity.status === 'failed' && 'text-destructive')}
        >
          {stopping ? '停止中…' : labels[activity.status]}
        </span>
      </div>
      <div className="flex items-start gap-1 rounded bg-background/50 pl-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all py-2 select-text">{activity.command}</code>
        <CopyButton text={activity.command} label={`复制 ${activity.name} 启动命令`} />
      </div>
      <div className="space-y-1 text-muted-foreground">
        <p className="break-all select-text">目录：{activity.cwd}</p>
        <p className="break-words">
          来源：{activity.sourceName} · {elapsed(activity, now)}
        </p>
        {activity.stopReason && <p className="break-words">{activity.stopReason}</p>}
        {activity.exitCode !== undefined && !live && <p>退出码：{activity.exitCode}</p>}
      </div>
      {activity.urls.map((value) => {
        const address = activityAddress(value, local)
        if (!address) return null
        return (
          <div key={value} className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1 break-all select-text">{address.url}</span>
            {address.openable ? (
              <a
                href={address.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`打开 ${activity.name} 页面`}
                className="rounded p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <span className="shrink-0 text-muted-foreground">Host 本机地址</span>
            )}
            <CopyButton text={address.url} label={`复制 ${activity.name} 地址`} />
          </div>
        )
      })}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" aria-expanded={logsOpen} onClick={() => setLogsOpen(!logsOpen)}>
          <ChevronDown className={cn('size-3.5 transition-transform', !logsOpen && '-rotate-90')} />
          {logsOpen ? '收起日志' : '查看日志'}
        </Button>
        {live && (
          <Button
            variant="ghost"
            size="sm"
            disabled={stopping || !state.connected}
            aria-label={`停止 ${activity.name}`}
            onClick={() => void store.stop(session, activity.serviceId)}
          >
            <Square className="size-3.5" />
            {stopping ? '停止中…' : error ? '重试停止' : '停止'}
          </Button>
        )}
      </div>
      {logsOpen && (
        <div className="space-y-1">
          {state.logErrors[activity.serviceId] && (
            <p role="alert" className="break-words text-destructive">
              {state.logErrors[activity.serviceId]}
            </p>
          )}
          {logs?.truncated && <p className="text-muted-foreground">仅保留最近日志，较早内容已截断。</p>}
          <pre
            ref={output}
            aria-label={`${activity.name} 日志`}
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget
              setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24)
            }}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-[11px] select-text"
          >
            {logs?.output || (state.logsLoading.includes(activity.serviceId) ? '正在读取日志…' : '暂无日志输出。')}
          </pre>
          {!follow && (
            <Button variant="ghost" size="sm" onClick={() => setFollow(true)}>
              回到底部
            </Button>
          )}
          {state.logErrors[activity.serviceId] && (
            <Button variant="ghost" size="sm" onClick={() => void store.loadLogs(session, activity.serviceId)}>
              重试读取日志
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

export function ActivityPanel({
  store,
  session,
  local,
  hostAddress,
}: {
  store: ActivityStore
  session: SessionRef
  local: boolean
  hostAddress?: string
}) {
  const state = useSyncExternalStore(store.subscribe, () => store.state(session))
  const [now, setNow] = useState(Date.now)
  const count = state.activities.filter(isLiveServiceActivity).length
  useEffect(() => {
    if (!count) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [count])
  const sorted = [...state.activities].sort(
    (a, b) => Number(isLiveServiceActivity(b)) - Number(isLiveServiceActivity(a)),
  )
  return (
    <section aria-label="当前活动服务" className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
      <div className="mb-3 space-y-1 px-1">
        <p aria-live="polite">
          {!state.connected
            ? '本会话 · 状态待确认'
            : !state.known
              ? '本会话 · 正在核对活动'
              : `本会话 · ${count} 个活动服务`}
        </p>
        <p className="break-all text-muted-foreground">
          服务运行在：{local ? '本机 Host' : hostAddress || '远程 Host'}
        </p>
        {!state.connected && (
          <p role="status" className="text-muted-foreground">
            连接中断，状态待确认。
          </p>
        )}
        {state.loading && !state.known && <p role="status">正在读取活动服务…</p>}
        {state.known && state.connected && !state.loading && !state.error && count === 0 && (
          <p role="status" className="py-2 text-muted-foreground">
            当前会话没有运行中的服务。
          </p>
        )}
        {state.error && (
          <div role="alert" className="text-destructive">
            <p className="break-words">无法读取活动：{state.error}</p>
            <Button variant="ghost" size="sm" onClick={() => void store.refresh(session)}>
              <RefreshCw className="size-3.5" />
              重试
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-3">
        {sorted.map((activity) => (
          <ActivityCard
            key={activity.serviceId}
            activity={activity}
            store={store}
            session={session}
            state={state}
            local={local}
            now={now}
          />
        ))}
      </div>
    </section>
  )
}
