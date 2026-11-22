import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UsageStatsSnapshot } from '@pi-meme/contracts/usage'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsGroup, settingsCardClassName, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { compactTokens, taskDuration } from './usage-chart-model'
import { TokenActivity } from './token-activity'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'

/** 会话级内存缓存，使设置页内标签切换时 0 延迟秒开，避免重复展示骨架屏 */
let cachedUsageSnapshot: UsageStatsSnapshot | null = null
let lastUsageFetchTime = 0

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚刚更新'
  return `更新于 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

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
          label: '累计 Token',
          value: compactTokens(snapshot.totalTokens),
          hint: `${compactTokens(snapshot.totalTokens)} Token（精确 ${snapshot.totalTokens.toLocaleString('zh-CN')}），包含输入、输出、缓存读取、缓存写入及已知的记忆后台用量。`,
        },
        {
          label: '单日峰值',
          value: compactTokens(snapshot.peakDailyTokens),
          hint: `单日最高 ${compactTokens(snapshot.peakDailyTokens)} Token（精确 ${snapshot.peakDailyTokens.toLocaleString('zh-CN')}），按系统本地日期统计。`,
        },
        {
          label: '最长任务',
          value: taskDuration(snapshot.longestTaskMs),
          hint: `从发送消息到回复完成的时间，包含工具执行。${snapshot.longestTaskMs === null ? '暂无已完成任务。' : `最长 ${snapshot.longestTaskMs.toLocaleString('zh-CN')} 毫秒。`}`,
        },
        { label: '最长连续', value: `${snapshot.longestStreak} 天`, hint: '全部历史中连续使用 Token 的最长天数。' },
        {
          label: '当前连续',
          value: `${snapshot.currentStreak} 天`,
          hint: '从今天或昨天向前计算连续使用 Token 的天数。',
        },
      ]
    : ['累计 Token', '单日峰值', '最长任务', '最长连续', '当前连续'].map((label) => ({
        label,
        value: error ? '读取失败' : '读取中…',
        hint: '正在读取历史用量统计。',
      }))

  return (
    <div aria-label="个人资料统计" aria-busy={loading} className="@container min-w-0 space-y-6">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <p role="status" className="truncate whitespace-nowrap text-[11px]">
          <CrossfadeText>
            {snapshot
              ? loading
                ? '正在更新统计…'
                : formatUpdatedAt(snapshot.updatedAt)
              : error
                ? '统计读取失败'
                : '正在读取统计…'}
          </CrossfadeText>
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-label="刷新 Token 统计"
          className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
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
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/10 p-4 text-xs text-destructive"
        >
          <p className="min-w-0 break-words">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
            disabled={loading}
            onClick={() => void refresh()}
          >
            重试
          </Button>
        </div>
      )}

      <div className="space-y-6">
        <TooltipProvider delayDuration={100}>
          <dl
            className={cn(settingsCardClassName, 'grid grid-cols-2 gap-y-4 divide-y-0 p-4 @min-[520px]:grid-cols-5')}
            aria-label="历史用量统计"
          >
            {metrics.map((metric) => (
              <Tooltip key={metric.label}>
                <TooltipTrigger asChild>
                  <div
                    tabIndex={0}
                    className="flex min-w-0 flex-col px-2 py-1 text-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @min-[520px]:border-r @min-[520px]:border-border/40 @min-[520px]:last:border-r-0"
                  >
                    <dt className="mt-1 whitespace-nowrap text-[11px] text-muted-foreground">{metric.label}</dt>
                    <dd className="-order-1 min-h-6 whitespace-nowrap text-base font-medium tabular-nums">
                      <CrossfadeText>{metric.value}</CrossfadeText>
                    </dd>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{metric.hint}</TooltipContent>
              </Tooltip>
            ))}
          </dl>
        </TooltipProvider>

        <SettingsGroup title="Token 活动" aria-label="Token 活动记录">
          <RevealContent ready={snapshot !== null}>
            {snapshot && <TokenActivity daily={snapshot.daily} today={snapshot.today} />}
          </RevealContent>
        </SettingsGroup>

        {snapshot?.memoryTotalTokens !== undefined && (
          <SettingsGroup title="记忆后台用量" aria-label="记忆后台用量">
            <TooltipProvider delayDuration={100}>
              <dl
                className={cn(settingsCardClassName, 'grid grid-cols-2 gap-4 divide-y-0 p-4 @min-[520px]:grid-cols-4')}
              >
                {[
                  {
                    label: '已知 Token',
                    value: compactTokens(snapshot.memoryTotalTokens),
                    hint: `精确 ${snapshot.memoryTotalTokens.toLocaleString('zh-CN')} Token`,
                  },
                  { label: '模型调用', value: `${snapshot.memoryCalls ?? 0} 次`, hint: '' },
                  {
                    label: 'Token 未知',
                    value: `${snapshot.memoryUnknownCalls ?? 0} 次`,
                    hint: '结果或 Token 未知的调用次数',
                  },
                  { label: '费用未知', value: `${snapshot.memoryUnknownCostCalls ?? 0} 次`, hint: '' },
                ].map((metric) =>
                  metric.hint ? (
                    <Tooltip key={metric.label}>
                      <TooltipTrigger asChild>
                        <div
                          tabIndex={0}
                          className="min-w-0 space-y-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <dt className="whitespace-nowrap text-xs text-muted-foreground">{metric.label}</dt>
                          <dd className="whitespace-nowrap text-sm font-medium tabular-nums">
                            <CrossfadeText>{metric.value}</CrossfadeText>
                          </dd>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>{metric.hint}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <div key={metric.label} className="min-w-0 space-y-1">
                      <dt className="whitespace-nowrap text-xs text-muted-foreground">{metric.label}</dt>
                      <dd className="whitespace-nowrap text-sm font-medium tabular-nums">
                        <CrossfadeText>{metric.value}</CrossfadeText>
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </TooltipProvider>
          </SettingsGroup>
        )}
      </div>
    </div>
  )
}
