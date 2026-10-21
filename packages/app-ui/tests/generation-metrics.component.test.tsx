import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ContextUsageRing } from '@pi-meme/models/ui/context-usage-ring'
import { formatMetricDuration } from '@pi-meme/models/ui/generation-metrics'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'

type GenerationMetricsSource = NonNullable<ComponentProps<typeof ContextUsageRing>['generationMetrics']>
type SessionStats = NonNullable<ComponentProps<typeof ContextUsageRing>['stats']>

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function createSource() {
  let value: ReturnType<GenerationMetricsSource['getSnapshot']>
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => value,
    update: (next: typeof value) => {
      value = next
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

function createStats(contextUsage?: SessionStats['contextUsage']): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: 'test',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 80000, output: 10000, cacheRead: 0, cacheWrite: 0, total: 90000 },
    cost: 0,
    contextUsage,
  }
}

function renderMetrics(source: GenerationMetricsSource, stats?: SessionStats | null) {
  const view = render(
    <TooltipProvider>
      <ContextUsageRing generationMetrics={source} stats={stats} />
    </TooltipProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '背景信息窗口占用' }))
  return view
}

test.each([
  undefined,
  null,
  createStats(),
  createStats({ tokens: null, percent: null, contextWindow: 100000 }),
  createStats({ tokens: 10000, percent: null, contextWindow: 100000 }),
  createStats({ tokens: null, percent: 10, contextWindow: 100000 }),
])('上下文用量未知时显示待统计和占位，不使用累计 token，TPS 保持可用 %#', (stats) => {
  const source = createSource()
  source.update({
    running: false,
    phase: 'complete',
    elapsedMs: 2000,
    generationMs: 2000,
    generationActive: false,
    ttftMs: 1200,
    outputTokens: 60,
    estimated: false,
    receivedAt: performance.now(),
  })
  renderMetrics(source, stats)
  expect(screen.getByText('待统计')).toBeInTheDocument()
  expect(screen.queryByText('0%')).not.toBeInTheDocument()
  expect(screen.queryByText(/^~/)).not.toBeInTheDocument()
  expect(screen.getAllByText('—')).toHaveLength(stats?.contextUsage ? 3 : 4)
  if (stats?.contextUsage) expect(screen.getByText('— / 100K')).toBeInTheDocument()
  expect(screen.getByText('30.0')).toBeInTheDocument()
})

test.each([
  { tokens: 0, percent: 0, expected: ['~0 / 100K', '~0', '~0', '~0'] },
  { tokens: 1000, percent: 1, expected: ['~1K / 100K', '~180', '~620', '~200'] },
  { tokens: 10000, percent: 10, expected: ['~10K / 100K', '~2K', '~8K', '~200'] },
])('有效上下文 tokens=$tokens 保留真实零值及现有分项估算', ({ tokens, percent, expected }) => {
  renderMetrics(createSource(), createStats({ tokens, percent, contextWindow: 100000 }))
  expect(screen.queryByText('待统计')).not.toBeInTheDocument()
  expect(screen.getByText(`${percent}%`)).toBeInTheDocument()
  expect(screen.getAllByText(/^~/).map((element) => element.textContent)).toEqual(expected)
})

test('空状态显示占位，生成时标记估算，结束后显示实际速率', () => {
  const source = createSource()
  renderMetrics(source)
  expect(screen.getByText('暂无记录')).toBeInTheDocument()
  act(() =>
    source.update({
      running: true,
      phase: 'generating',
      elapsedMs: 2000,
      generationMs: 2000,
      generationActive: true,
      ttftMs: 1200,
      outputTokens: 60,
      estimated: true,
      receivedAt: performance.now(),
    }),
  )
  expect(screen.getByText('≈ 30.0')).toBeInTheDocument()
  expect(screen.getByText('1.2s')).toBeInTheDocument()
  act(() =>
    source.update({
      running: false,
      phase: 'complete',
      elapsedMs: 20200,
      generationMs: 16000,
      generationActive: false,
      ttftMs: 6200,
      outputTokens: 561,
      estimated: false,
      receivedAt: performance.now(),
    }),
  )
  expect(screen.getByText('35.1')).toBeInTheDocument()
  expect(screen.getByText('20.2s')).toBeInTheDocument()
  expect(screen.getByText('6.2s')).toBeInTheDocument()
  expect(screen.queryByText('≈ 30.0')).not.toBeInTheDocument()
})

test('重新打开时计入采样后经过的时间，工具执行只增加总耗时，卸载释放计时和订阅', () => {
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  const interval = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const source = createSource()
  source.update({
    running: true,
    phase: 'tools',
    elapsedMs: 5000,
    generationMs: 2000,
    generationActive: false,
    ttftMs: 1000,
    outputTokens: 20,
    estimated: false,
    receivedAt: performance.now() - 3000,
  })
  const view = renderMetrics(source)
  expect(screen.getByText('8.0s')).toBeInTheDocument()
  expect(screen.getByText('10.0')).toBeInTheDocument()
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(screen.getByText('9.0s')).toBeInTheDocument()
  expect(screen.getByText('10.0')).toBeInTheDocument()
  const timer = interval.mock.results[interval.mock.calls.findIndex(([, delay]) => delay === 250)].value
  view.unmount()
  expect(source.listeners.size).toBe(0)
  expect(clear).toHaveBeenCalledWith(timer)
})

test('悬停指标文字不打开说明，移入感叹号或聚焦图标后才显示', () => {
  vi.useFakeTimers()
  renderMetrics(createSource())
  expect(screen.getAllByRole('button', { name: /说明$/ })).toHaveLength(7)
  expect(screen.queryByText('输入 ↑')).not.toBeInTheDocument()
  expect(screen.queryByText('输出 ↓')).not.toBeInTheDocument()
  expect(screen.queryByText('速率含首响应等待，不计工具执行时间。')).not.toBeInTheDocument()
  const info = screen.getByRole('button', { name: 'TPS说明' })
  fireEvent.pointerMove(screen.getByText('TPS'), { pointerType: 'mouse' })
  act(() => vi.advanceTimersByTime(200))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  fireEvent.pointerMove(info, { pointerType: 'mouse' })
  act(() => vi.advanceTimersByTime(200))
  expect(screen.getByRole('tooltip')).toHaveTextContent('排除工具执行时间')
  expect(screen.getByRole('dialog', { name: '上下文与生成指标' })).toBeInTheDocument()
  fireEvent.pointerLeave(info)
  fireEvent.focus(screen.getByRole('button', { name: '首响应 TTFT说明' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('首次有效响应')
  expect(screen.getByRole('dialog', { name: '上下文与生成指标' })).toBeInTheDocument()
})

test('formatMetricDuration 正确转化时分秒并处理临界防跳变与补零', () => {
  expect(formatMetricDuration(-100)).toBe('0.0s')
  expect(formatMetricDuration(Number.NaN)).toBe('0.0s')
  expect(formatMetricDuration(0)).toBe('0.0s')
  expect(formatMetricDuration(500)).toBe('0.5s')
  expect(formatMetricDuration(5300)).toBe('5.3s')
  expect(formatMetricDuration(59940)).toBe('59.9s')
  expect(formatMetricDuration(59960)).toBe('1m 00s')
  expect(formatMetricDuration(60000)).toBe('1m 00s')
  expect(formatMetricDuration(65000)).toBe('1m 05s')
  expect(formatMetricDuration(683100)).toBe('11m 23s')
  expect(formatMetricDuration(3599000)).toBe('59m 59s')
  expect(formatMetricDuration(3600000)).toBe('1h 00m 00s')
  expect(formatMetricDuration(3665000)).toBe('1h 01m 05s')
})

test('指标卡片支持展示分秒级总耗时与超长首响应 TTFT，并支持小时级展示', () => {
  const source = createSource()
  renderMetrics(source)
  act(() =>
    source.update({
      running: false,
      phase: 'complete',
      elapsedMs: 683100,
      generationMs: 300000,
      generationActive: false,
      ttftMs: 125000,
      outputTokens: 1500,
      estimated: false,
      receivedAt: performance.now(),
    }),
  )
  expect(screen.getByText('11m 23s')).toBeInTheDocument()
  expect(screen.getByText('2m 05s')).toBeInTheDocument()

  act(() =>
    source.update({
      running: false,
      phase: 'complete',
      elapsedMs: 3665000,
      generationMs: 2000000,
      generationActive: false,
      ttftMs: 3200,
      outputTokens: 5000,
      estimated: false,
      receivedAt: performance.now(),
    }),
  )
  expect(screen.getByText('1h 01m 05s')).toBeInTheDocument()
  expect(screen.getByText('3.2s')).toBeInTheDocument()
})
