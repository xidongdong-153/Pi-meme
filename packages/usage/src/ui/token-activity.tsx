import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DailyTokenUsage } from '@pi-meme/contracts/usage'
import { settingsCardClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { activityCells, availableYears, compactTokens, parseDate, type ActivityPeriod } from './usage-chart-model'

const colors = ['bg-secondary', 'bg-blue-900', 'bg-blue-700', 'bg-blue-500', 'bg-blue-300']
const modes = [
  { id: 'day', label: '每天' },
  { id: 'week', label: '每周' },
  { id: 'month', label: '每月' },
] as const

function displayDate(value: string): string {
  const date = parseDate(value)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function displayShortDate(value: string): string {
  const date = parseDate(value)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function TokenActivity({ daily, today }: { daily: DailyTokenUsage[]; today: string }) {
  const years = useMemo(() => availableYears(daily, today), [daily, today])
  const currentYear = years[years.length - 1]
  const [selectedYear, setSelectedYear] = useState(currentYear)
  const year = years.includes(selectedYear) ? selectedYear : currentYear
  const yearIndex = years.indexOf(year)

  const [period, setPeriod] = useState<ActivityPeriod>('day')
  const cells = useMemo(() => activityCells(daily, year, period, today), [daily, year, period, today])
  const maximum = Math.max(0, ...cells.map((cell) => cell.tokens))
  const total = cells.reduce((sum, cell) => sum + cell.tokens, 0)
  const columns = period === 'day' ? cells.length / 7 : cells.length

  const months = useMemo(() => {
    if (period === 'month') {
      return Array.from({ length: 12 }, (_, index) => ({ index, label: `${index + 1}月` }))
    }
    if (period === 'day') {
      return cells.flatMap((cell, index) => {
        if (!cell.inRange) return []
        const date = parseDate(cell.date)
        if (date.getDate() !== 1) return []
        return [{ index: Math.floor(index / 7), label: `${date.getMonth() + 1}月` }]
      })
    }
    return Array.from({ length: 12 }, (_, month) => {
      const firstDay = `${year}-${String(month + 1).padStart(2, '0')}-01`
      const index = cells.findIndex((cell) => cell.date <= firstDay && cell.endDate >= firstDay)
      return { index: index >= 0 ? index : 0, label: `${month + 1}月` }
    })
  }, [cells, period, year])

  return (
    <section
      aria-label="Token 活动"
      className={cn(settingsCardClassName, '@container/activity space-y-4 divide-y-0 p-4')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="统计年份">
          <button
            type="button"
            aria-label="上一年"
            disabled={yearIndex <= 0}
            onClick={() => setSelectedYear(years[yearIndex - 1])}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="min-w-[3.75rem] text-center text-xs font-medium tabular-nums whitespace-nowrap">
            {year}年
          </span>
          <button
            type="button"
            aria-label="下一年"
            disabled={yearIndex >= years.length - 1}
            onClick={() => setSelectedYear(years[yearIndex + 1])}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
        <div
          role="group"
          aria-label="活动统计周期"
          className="flex shrink-0 flex-nowrap gap-1 rounded-lg bg-secondary/50 p-1"
        >
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              aria-pressed={period === mode.id}
              onClick={() => setPeriod(mode.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${period === mode.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <TooltipProvider delayDuration={100}>
        <div className="overflow-x-auto pb-1" tabIndex={0} aria-label="Token 活动图">
          <div className="w-full min-w-[360px]">
            {period === 'month' ? (
              <div
                aria-label="每月 Token 柱状图"
                className="grid h-40 grid-cols-12 items-end gap-1 border-b border-border/60 @min-[480px]/activity:gap-1.5"
              >
                {cells.map((cell, monthIndex) => {
                  const title = `${year}年${monthIndex + 1}月`
                  const compact = compactTokens(cell.tokens)
                  const ariaLabel = cell.isFuture ? `${title}，尚未到达` : `${title}，${compact} Token`
                  const heightPercent = cell.tokens > 0 && maximum > 0 ? Math.max(4, (cell.tokens / maximum) * 100) : 0
                  return (
                    <Tooltip key={cell.date}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={ariaLabel}
                          className="group flex h-full min-w-0 flex-col items-center justify-end gap-1 rounded-t-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <span className="hidden h-3.5 text-[10px] leading-none text-muted-foreground tabular-nums whitespace-nowrap @min-[480px]/activity:inline">
                            {!cell.isFuture && cell.tokens > 0 ? compact : ''}
                          </span>
                          <span className="flex w-full flex-1 items-end">
                            <span
                              className={cn(
                                'w-full rounded-t-sm transition-colors',
                                cell.isFuture
                                  ? 'bg-secondary/35'
                                  : cell.tokens > 0
                                    ? 'bg-blue-500 group-hover:bg-blue-400'
                                    : 'bg-secondary',
                              )}
                              style={{ height: heightPercent > 0 ? `${heightPercent}%` : '3px' }}
                            />
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="whitespace-nowrap">{title}</p>
                        {cell.isFuture ? (
                          <p className="mt-1 whitespace-nowrap opacity-75">尚未到达</p>
                        ) : (
                          <>
                            <p className="mt-1 whitespace-nowrap font-medium tabular-nums">{compact} Token</p>
                            {cell.tokens >= 1000 && (
                              <p className="mt-0.5 whitespace-nowrap text-[11px] opacity-75 tabular-nums">
                                精确 {cell.tokens.toLocaleString('zh-CN')}
                              </p>
                            )}
                          </>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            ) : (
              <div
                aria-label={period === 'day' ? '每日 Token 热力图' : '每周 Token 柱状图'}
                className={
                  period === 'day'
                    ? 'grid grid-flow-col grid-rows-7 gap-[1px] @min-[520px]/activity:gap-[2px]'
                    : 'grid h-36 items-end gap-[1px] border-b border-border/60 @min-[520px]/activity:gap-[2px]'
                }
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
              >
                {cells.map((cell) => {
                  const level = cell.tokens > 0 && maximum > 0 ? Math.max(1, Math.ceil((cell.tokens / maximum) * 4)) : 0
                  const dateLabel =
                    period === 'day'
                      ? displayDate(cell.date)
                      : `${displayShortDate(cell.date)} – ${displayShortDate(cell.endDate)}`
                  const compact = compactTokens(cell.tokens)
                  const ariaLabel = cell.isFuture ? `${dateLabel}，尚未到达` : `${dateLabel}，${compact} Token`
                  return cell.inRange ? (
                    <Tooltip key={cell.date}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={ariaLabel}
                          className={cn(
                            'w-full rounded-[2px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            period === 'day'
                              ? cn('aspect-square', cell.isFuture ? 'bg-secondary/35' : colors[level])
                              : cell.isFuture
                                ? 'bg-secondary/35'
                                : cell.tokens > 0
                                  ? 'bg-blue-500 hover:bg-blue-400'
                                  : 'bg-secondary',
                          )}
                          style={
                            period === 'day'
                              ? undefined
                              : {
                                  height:
                                    cell.tokens > 0 && maximum > 0
                                      ? `${Math.max(4, (cell.tokens / maximum) * 100)}%`
                                      : '3px',
                                }
                          }
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="whitespace-nowrap">{dateLabel}</p>
                        {cell.isFuture ? (
                          <p className="mt-1 whitespace-nowrap opacity-75">尚未到达</p>
                        ) : (
                          <>
                            <p className="mt-1 whitespace-nowrap font-medium tabular-nums">{compact} Token</p>
                            {cell.tokens >= 1000 && (
                              <p className="mt-0.5 whitespace-nowrap text-[11px] opacity-75 tabular-nums">
                                精确 {cell.tokens.toLocaleString('zh-CN')}
                              </p>
                            )}
                          </>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span key={cell.date} aria-hidden="true" className="aspect-square" />
                  )
                })}
              </div>
            )}

            <div
              className={cn(
                'mt-2 grid text-[11px] text-muted-foreground',
                period === 'month' ? 'grid-cols-12 gap-1 text-center @min-[480px]/activity:gap-1.5' : '',
              )}
              style={period === 'month' ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {months.map((month, idx) => {
                const nextIndex = idx < months.length - 1 ? months[idx + 1].index : columns
                const span = Math.max(1, nextIndex - month.index)
                return (
                  <span
                    key={month.label}
                    className={cn(
                      'whitespace-nowrap',
                      period !== 'month' && columns - month.index < 3 ? 'justify-self-end' : '',
                    )}
                    style={period === 'month' ? undefined : { gridColumn: `${month.index + 1} / span ${span}` }}
                  >
                    {month.label}
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      </TooltipProvider>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="whitespace-nowrap tabular-nums">
          {total ? `${year}年累计 ${compactTokens(total)} Token` : `${year}年暂无 Token 活动`}
        </span>
        {period === 'day' && (
          <div aria-label="用量颜色从少到多" className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <span className="mr-0.5">少</span>
            {colors.map((color) => (
              <span key={color} className={`size-2.5 rounded-[2px] ${color}`} />
            ))}
            <span className="ml-0.5">多</span>
          </div>
        )}
      </div>
    </section>
  )
}
