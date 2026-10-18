import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PiGenerationMetrics } from '@pi-meme/contracts/pi'
import { MetricLabel } from './metric-label'

export type GenerationMetricsSource = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => (PiGenerationMetrics & { receivedAt: number }) | undefined
}

const phaseLabels: Record<PiGenerationMetrics['phase'], string> = {
  waiting: '等待响应',
  generating: '正在生成',
  tools: '工具执行中',
  complete: '已结束',
  aborted: '已中断',
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`
}

export function GenerationMetrics({ source }: { source: GenerationMetricsSource }) {
  const metrics = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const [now, setNow] = useState(() => performance.now())
  const running = metrics?.running ?? false
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(timer)
  }, [running])

  const delta = metrics && running ? Math.max(0, now - metrics.receivedAt) : 0
  const elapsedMs = (metrics?.elapsedMs ?? 0) + delta
  const generationMs = (metrics?.generationMs ?? 0) + (metrics?.generationActive ? delta : 0)
  const tps =
    metrics && metrics.outputTokens > 0 && generationMs > 0 ? (metrics.outputTokens * 1000) / generationMs : undefined
  const approximate = metrics?.estimated ? '≈ ' : ''

  return (
    <section aria-label="模型生成指标" className="border-t border-border/70 pt-2.5 space-y-2.5">
      <div className="flex items-center justify-between text-[0.6875rem] text-muted-foreground">
        <span>{running ? '本次生成' : '上次生成'}</span>
        <span>{metrics ? phaseLabels[metrics.phase] : '暂无记录'}</span>
      </div>
      <div className="flex items-baseline gap-1.5 tabular-nums">
        <span className="text-[0.6875rem] text-muted-foreground">
          <MetricLabel
            label="TPS"
            description="本次运行每秒生成的输出 token。包含首响应等待与模型思考，排除工具执行时间；多次模型请求合并计算。≈ 表示流式估算，收到实际用量后校准。"
          />
        </span>
        <span className="text-xl font-semibold leading-none text-foreground">
          {tps === undefined ? '—' : `${approximate}${tps.toFixed(1)}`}
        </span>
        <span className="text-[0.6875rem] text-muted-foreground">tok/s</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[0.6875rem] tabular-nums">
        <div className="flex items-center justify-between gap-1">
          <dt className="text-muted-foreground">
            <MetricLabel
              label="首响应 TTFT"
              description="从模型请求开始到首段正文、思考或工具调用增量的等待时间。本次运行显示首次有效响应的 TTFT。"
            />
          </dt>
          <dd className="text-foreground">{metrics?.ttftMs === undefined ? '—' : seconds(metrics.ttftMs)}</dd>
        </div>
        <div className="flex items-center justify-between gap-1">
          <dt className="text-muted-foreground">
            <MetricLabel label="总耗时" description="本次运行开始至结束的总时长，包含模型生成、等待和工具执行时间。" />
          </dt>
          <dd className="text-foreground">{metrics ? seconds(elapsedMs) : '—'}</dd>
        </div>
      </dl>
    </section>
  )
}
