import { useMemo, useState } from 'react'
import type { DailyTokenUsage } from '@pi-meme/contracts/usage'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { activityCells, activityRange, compactTokens, parseDate, type ActivityPeriod } from './usage-chart-model'

const colors = ['bg-secondary', 'bg-blue-900', 'bg-blue-700', 'bg-blue-500', 'bg-blue-300']
const modes = [
  { id: 'day', label: '每天' },
  { id: 'week', label: '每周' },
  { id: 'month', label: '每月' },
] as const

function displayDate(value: string): string {
  return parseDate(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function TokenActivity({ daily, today }: { daily: DailyTokenUsage[]; today: string }) {
  const [period, setPeriod] = useState<ActivityPeriod>('day')
  const cells = useMemo(() => activityCells(daily, today, period), [daily, today, period])
  const maximum = Math.max(0, ...cells.map((cell) => cell.tokens))
  const total = cells.reduce((sum, cell) => sum + cell.tokens, 0)
  const range = activityRange(today)
  const months = cells.flatMap((cell, index) => {
    if (!cell.inRange) return []
    const date = parseDate(cell.date)
    if (period === 'day' && date.getDate() !== 1) return []
    if (period === 'week' && index > 0 && parseDate(cells[index - 1].date).getMonth() === date.getMonth()) return []
    return [{ index: period === 'day' ? Math.floor(index / 7) : index, label: `${date.getMonth() + 1}月` }]
  })
  const columns = period === 'day' ? cells.length / 7 : cells.length

  return (
    <section aria-label="Token 活动" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-medium">Token 活动</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {displayDate(range.start)}至{displayDate(range.end)}
          </p>
        </div>
        <div role="group" aria-label="活动统计周期" className="flex gap-1 rounded-lg bg-secondary/50 p-1">
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              aria-pressed={period === mode.id}
              onClick={() => setPeriod(mode.id)}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${period === mode.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>
      <TooltipProvider delayDuration={100}>
        <div className="overflow-x-auto pb-2" tabIndex={0} aria-label="Token 活动图，可横向滚动">
          <div className={period === 'month' ? 'min-w-[480px]' : 'min-w-[680px]'}>
            <div
              aria-label={
                period === 'day' ? '每日 Token 热力图' : period === 'week' ? '每周 Token 柱状图' : '每月 Token 柱状图'
              }
              className={
                period === 'day'
                  ? 'grid grid-flow-col grid-rows-7 gap-1'
                  : 'grid h-36 items-end gap-1 border-b border-border'
              }
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {cells.map((cell) => {
                const level = cell.tokens > 0 ? Math.max(1, Math.ceil((cell.tokens / maximum) * 4)) : 0
                const dateLabel =
                  cell.date === cell.endDate
                    ? displayDate(cell.date)
                    : `${displayDate(cell.date)}至${displayDate(cell.endDate)}`
                const label = `${dateLabel}，${cell.tokens.toLocaleString('zh-CN')} 个 Token`
                return cell.inRange ? (
                  <Tooltip key={cell.date}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={label}
                        className={`w-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${period === 'day' ? `aspect-square ${colors[level]}` : cell.tokens ? 'bg-blue-500 hover:bg-blue-400' : 'bg-secondary'}`}
                        style={
                          period === 'day'
                            ? undefined
                            : { height: cell.tokens ? `${Math.max(3, (cell.tokens / maximum) * 100)}%` : 3 }
                        }
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{dateLabel}</p>
                      <p className="mt-1">{cell.tokens.toLocaleString('zh-CN')} 个 Token</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span key={cell.date} aria-hidden="true" className="aspect-square" />
                )
              })}
            </div>
            <div
              className="mt-2 grid text-xs text-muted-foreground"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {months.map((month) => (
                <span
                  key={month.index}
                  className={`whitespace-nowrap ${columns - month.index < 3 ? 'justify-self-end' : ''}`}
                  style={{
                    gridColumn:
                      period === 'month'
                        ? month.index + 1
                        : `${month.index + 1} / span ${Math.min(3, columns - month.index)}`,
                  }}
                >
                  {month.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </TooltipProvider>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{total ? `近 12 个月使用 ${compactTokens(total)} 个 Token` : '近 12 个月暂无 Token 活动'}</span>
        {period === 'day' && (
          <div aria-label="用量颜色从少到多" className="flex items-center gap-1.5">
            <span className="mr-1">少</span>
            {colors.map((color) => (
              <span key={color} className={`size-3 rounded-sm ${color}`} />
            ))}
            <span className="ml-1">多</span>
          </div>
        )}
      </div>
    </section>
  )
}
