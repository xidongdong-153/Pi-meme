import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UsageStatsSnapshot } from '@pi-meme/contracts/usage'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { compactTokens, taskDuration } from './usage-chart-model'
import { TokenActivity } from './token-activity'
import { ProfileSkeleton } from './profile-skeleton'

/** 会话级内存缓存，使设置页内标签切换时 0 延迟秒开，避免重复展示骨架屏 */
let cachedUsageSnapshot: UsageStatsSnapshot | null = null
let lastUsageFetchTime = 0

export function ProfileSettings({ loadUsage }: { loadUsage: () => Promise<UsageStatsSnapshot> }) {
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(cachedUsageSnapshot)
  const [loading, setLoading] = useState(() => cachedUsageSnapshot === null)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++revision.current
    setLoading(true)
    setError('')
    try {
      const next = await loadUsage()
      if (request === revision.current) {
        cachedUsageSnapshot = next
        lastUsageFetchTime = Date.now()
        setSnapshot(next)
      }
    } catch (cause) {
      if (request === revision.current)
        setError(`无法加载 Token 统计：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (request === revision.current) setLoading(false)
    }
  }, [loadUsage])

  useEffect(() => {
    // 若已有缓存且在 10 秒之内获取过，跳过首次无意义重复请求；否则后台静默更新
    const isFresh = cachedUsageSnapshot !== null && Date.now() - lastUsageFetchTime < 10_000
    if (!isFresh) {
      void refresh()
    }
    const onFocus = () => {
      // 窗口切回时增加 15 秒防抖，避免频繁切屏触发全盘扫描
      if (Date.now() - lastUsageFetchTime > 15_000) {
        void refresh()
      }
    }
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
          hint: `从发送消息到回复完成的时间，包含工具执行。${snapshot.longestTaskMs === null ? '暂无已完成任务。' : `最长 ${snapshot.longestTaskMs.toLocaleString('zh-CN')} 毫秒。`}`,
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
      <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground">
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
      {!snapshot && !error && <ProfileSkeleton showHeader={false} testId="profile-skeleton" className="space-y-10" />}
      {snapshot && (
        <div className="space-y-10 animate-in fade-in-0 duration-200 fill-mode-forwards ease-out">
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
            <p>更新于 {new Date(snapshot.updatedAt).toLocaleString('zh-CN')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
