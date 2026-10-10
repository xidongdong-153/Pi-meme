import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UsageStatsSnapshot } from '@pi-meme/contracts/usage'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { compactTokens, taskDuration } from './usage-chart-model'
import { TokenActivity } from './token-activity'

export function ProfileSettings({ loadUsage }: { loadUsage: () => Promise<UsageStatsSnapshot> }) {
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++revision.current
    setLoading(true)
    setError('')
    try {
      const next = await loadUsage()
      if (request === revision.current) setSnapshot(next)
    } catch (cause) {
      if (request === revision.current)
        setError(`无法加载 Token 统计：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (request === revision.current) setLoading(false)
    }
  }, [loadUsage])

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      revision.current += 1
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const metrics = snapshot
    ? [
        {
          label: '累计 Token 数',
          value: compactTokens(snapshot.totalTokens),
          hint: `${snapshot.totalTokens.toLocaleString('zh-CN')} 个 Token，包含输入、输出、缓存读取和缓存写入。`,
        },
        {
          label: '单日 Token 峰值',
          value: compactTokens(snapshot.peakDailyTokens),
          hint: `单日最高 ${snapshot.peakDailyTokens.toLocaleString('zh-CN')} 个 Token，按系统本地日期统计。`,
        },
        {
          label: '最长任务用时',
          value: taskDuration(snapshot.longestTaskMs),
          hint: `根据历史时间戳，计算一轮用户消息到最终成功回复落盘的耗时，包含工具执行。${snapshot.longestTaskMs === null ? '暂无已完成任务。' : `最长 ${snapshot.longestTaskMs.toLocaleString('zh-CN')} 毫秒。`}`,
        },
        { label: '最长连续天数', value: `${snapshot.longestStreak} 天`, hint: '全部历史中连续使用 Token 的最长天数。' },
        {
          label: '当前连续天数',
          value: `${snapshot.currentStreak} 天`,
          hint: '从今天或昨天向前计算连续使用 Token 的天数。',
        },
      ]
    : []

  return (
    <div aria-label="个人资料统计" aria-busy={loading} className="@container min-w-0 space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p>本机全部 Pi 历史会话，包含 CLI 和桌面端。</p>
        <Button
          variant="ghost"
          size="sm"
          aria-label="刷新 Token 统计"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p className="min-w-0 break-words">{error}</p>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      )}
      {!snapshot && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取 Token 统计…
        </p>
      )}
      {snapshot && (
        <>
          <TooltipProvider delayDuration={100}>
            <dl
              className="grid grid-cols-2 gap-y-5 rounded-2xl border border-border bg-card/30 px-3 py-5 @min-[600px]:grid-cols-5"
              aria-label="历史用量统计"
            >
              {metrics.map((metric) => (
                <Tooltip key={metric.label}>
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      className="flex min-w-0 flex-col px-2 py-1 text-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @min-[600px]:border-r @min-[600px]:border-border @min-[600px]:last:border-r-0"
                    >
                      <dt className="mt-2 text-xs text-muted-foreground">{metric.label}</dt>
                      <dd className="-order-1 mt-1 text-lg font-medium tabular-nums">{metric.value}</dd>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{metric.hint}</TooltipContent>
                </Tooltip>
              ))}
            </dl>
          </TooltipProvider>
          <TokenActivity daily={snapshot.daily} today={snapshot.today} />
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>更新于 {new Date(snapshot.updatedAt).toLocaleString('zh-CN')}。删除历史会话后，统计会随刷新减少。</p>
            {snapshot.warnings.map((warning, index) => (
              <p key={`${index}-${warning}`} role="status" className="break-words">
                {warning}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
