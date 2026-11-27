import { Button } from '@pi-meme/ui/components/ui/button'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { AppWindow, Check, Code2, Copy, Search } from 'lucide-react'
import * as React from 'react'
import { computerSurfaceLabel, parseComputerResult, type ComputerToolInfo } from '../model/tool-details'

const actionLabels: Record<string, string> = {
  windows: '窗口列表',
  screenshot: '窗口截图',
  launch: '打开应用',
  click: '点击控件',
  setValue: '填写控件',
  press: '发送按键',
}

const phaseLabels = new Map([
  ['target', '定位目标'],
  ['focus', '窗口聚焦'],
  ['observation', '读取界面'],
  ['action', '执行动作'],
])
const deliveryLabels = new Map([
  ['not_delivered', '动作未送达'],
  ['delivered_unverified', '动作已送达，结果待确认'],
  ['delivery_uncertain', '动作是否送达待确认'],
  ['delivered_verified', '工具已核对动作结果'],
])

type FlatSnapshotNode = {
  key: string
  depth: number
  role: string
  label: string
  value?: string
  refId?: string
  disabled?: boolean
  focused?: boolean
  windowAction?: string
  url?: string
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return undefined
}

function flattenTree(node: unknown, depth = 0, out: FlatSnapshotNode[] = [], prefix = '0'): FlatSnapshotNode[] {
  if (!node || typeof node !== 'object') return out
  const rec = node as Record<string, unknown>
  const role = readString(rec, 'role', 'type', 'kind') ?? 'element'
  const label = readString(rec, 'name', 'title', 'label', 'description', 'help') ?? ''
  const value = readString(rec, 'value', 'text')
  const refId = readString(rec, 'ref_id', 'refId', 'ref')
  const url = readString(rec, 'url')
  const disabled = rec.disabled === true || rec.enabled === false
  const focused = rec.focused === true
  const windowAction = readString(rec, 'window_action')

  if (label || value || refId || role !== 'element') {
    out.push({
      key: `${prefix}:${refId ?? out.length}`,
      depth,
      role,
      label,
      value,
      refId,
      disabled,
      focused,
      windowAction,
      url,
    })
  }

  if (Array.isArray(rec.children)) {
    rec.children.forEach((child, index) => flattenTree(child, depth + 1, out, `${prefix}.${index}`))
  }
  return out
}

function parsePlainSnapshot(text: string): { focusedLine?: string; nodes: FlatSnapshotNode[] } | undefined {
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return
  let focusedLine: string | undefined
  const nodes: FlatSnapshotNode[] = []
  let matchedCount = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.startsWith('The focused UI element is ')) {
      focusedLine = trimmed.slice('The focused UI element is '.length)
      matchedCount++
      continue
    }
    const match = /^([ \t]*)(\d+)[ \t]+(\S.*)$/.exec(line)
    if (match) {
      matchedCount++
      const indent = match[1]!.length
      const index = match[2]!
      const rest = match[3]!.trim()
      const disabled = rest.includes('(disabled)')
      const clean = rest.replace(/\(disabled\)\s*/g, '').trim()
      const spaceIdx = clean.indexOf(' ')
      const role = spaceIdx > 0 ? clean.slice(0, spaceIdx) : clean
      const label = spaceIdx > 0 ? clean.slice(spaceIdx + 1).trim() : ''
      nodes.push({
        key: `${i}:${index}`,
        depth: Math.floor(indent / 2),
        role,
        label,
        refId: `#${index}`,
        disabled,
      })
    }
  }

  if (matchedCount < 2) return
  return { focusedLine, nodes }
}

export const ComputerToolDetails = React.memo(ComputerToolDetailsContent)

function ComputerToolDetailsContent({
  info,
  result,
  isRunning,
  isPaused,
  isError,
  hasImages = false,
}: {
  info: ComputerToolInfo
  result: unknown
  isRunning: boolean
  isPaused: boolean
  isError: boolean
  hasImages?: boolean
}) {
  const [showRaw, setShowRaw] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle')

  const { parsed, rawText, error, delivery, retry, target } = React.useMemo(() => parseComputerResult(result), [result])

  const formattedRaw = React.useMemo(() => {
    if (!rawText) return ''
    if (typeof parsed === 'object' && parsed !== null) {
      try {
        return JSON.stringify(parsed, null, 2)
      } catch {
        return rawText
      }
    }
    return rawText
  }, [parsed, rawText])

  React.useEffect(() => {
    if (copyState === 'idle') return
    const timer = setTimeout(setCopyState, 2000, 'idle')
    return () => clearTimeout(timer)
  }, [copyState])

  const snapshotData = React.useMemo(() => {
    if (info.action !== 'snapshot') return undefined
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>
      if (rec.tree && typeof rec.tree === 'object') {
        return {
          nodes: flattenTree(rec.tree),
          focusedLine: typeof rec.focused === 'string' ? rec.focused : undefined,
        }
      }
    }
    if (typeof parsed === 'string') return parsePlainSnapshot(parsed)
    return undefined
  }, [info.action, parsed])

  const windowsList = React.useMemo(() => {
    if (info.action !== 'windows' || !Array.isArray(parsed)) return undefined
    return parsed.filter((item): item is { id?: string; title?: string } => Boolean(item && typeof item === 'object'))
  }, [info.action, parsed])

  const filteredNodes = React.useMemo(() => {
    if (!snapshotData) return []
    const q = filter.trim().toLowerCase()
    if (!q) return snapshotData.nodes
    return snapshotData.nodes.filter(
      (node) =>
        node.label.toLowerCase().includes(q) ||
        node.role.toLowerCase().includes(q) ||
        (node.value?.toLowerCase().includes(q) ?? false) ||
        (node.refId?.toLowerCase().includes(q) ?? false),
    )
  }, [snapshotData, filter])

  const actionLabel =
    info.action === 'snapshot' ? computerSurfaceLabel(info.surface) : (actionLabels[info.action] ?? info.operation)
  const errorCode = error?.nativeCode ?? error?.code
  const phase = phaseLabels.get(error?.phase ?? '')
  const deliveryLabel = deliveryLabels.get(delivery ?? '')
  const recovery = error?.recovery ?? (retry === 'unsafe' ? '请先回读界面确认结果' : undefined)
  const hasRaw = Boolean(formattedRaw)
  const copyFeedback = copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制原始数据'

  let statText = ''
  if (windowsList) statText = `${windowsList.length} 个窗口`
  else if (snapshotData) {
    statText = filter.trim()
      ? `${filteredNodes.length} / ${snapshotData.nodes.length} 个控件`
      : `${snapshotData.nodes.length} 个控件`
  } else if (info.windowId) {
    statText = `窗口 ${info.windowId}`
  }

  return (
    <div className="my-2 min-w-0 overflow-hidden rounded-lg border border-border/70 bg-transparent text-xs text-muted-foreground select-text">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
        <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground/85">
          {actionLabel}
        </span>
        {info.app && <span className="min-w-0 truncate font-medium text-foreground/90">{info.app}</span>}
        {statText && <span className="ml-auto shrink-0 tabular-nums text-[11px]">{statText}</span>}
        <div className={cn('flex items-center gap-0.5', !statText && 'ml-auto')}>
          {hasRaw && !(hasImages && !isError && info.action === 'screenshot') && (
            <TooltipHint content={showRaw ? '切换为结构化视图' : '查看原始数据'}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={showRaw ? '切换为结构化视图' : '查看原始数据'}
                aria-pressed={showRaw}
                className={cn(
                  'size-6 text-muted-foreground hover:text-foreground',
                  showRaw && 'bg-muted/70 text-foreground',
                )}
                onClick={() => setShowRaw((prev) => !prev)}
              >
                <Code2 className="size-3.5" />
              </Button>
            </TooltipHint>
          )}
          {hasRaw && (
            <TooltipHint content={copyFeedback}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copyFeedback}
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(formattedRaw)
                    setCopyState('copied')
                  } catch {
                    setCopyState('failed')
                  }
                }}
              >
                {copyState === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </TooltipHint>
          )}
        </div>
      </div>

      {showRaw ? (
        <pre className="max-h-[min(16rem,40dvh)] overflow-auto overscroll-contain p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {formattedRaw}
        </pre>
      ) : error || isError ? (
        <div className="space-y-1 px-3 py-2.5">
          <p className="text-foreground [overflow-wrap:anywhere]">
            {error?.message || rawText || '工具未返回错误详情'}
          </p>
          {(errorCode || phase) && (
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              {errorCode && <span className="font-mono text-[11px]">{errorCode}</span>}
              {phase && <span>{phase}</span>}
            </div>
          )}
          {(deliveryLabel || recovery) && (
            <p className="[overflow-wrap:anywhere]">{[deliveryLabel, recovery].filter(Boolean).join('。')}</p>
          )}
        </div>
      ) : isRunning && !rawText && !hasImages ? (
        <div className="px-3 py-2.5">{isPaused ? '已暂停，等待继续执行…' : '正在与本机应用交互…'}</div>
      ) : info.action === 'screenshot' && hasImages ? null : windowsList ? (
        windowsList.length === 0 ? (
          <div className="px-3 py-2.5">未找到可用窗口</div>
        ) : (
          <div className="divide-y divide-border/40 max-h-[min(14rem,35dvh)] overflow-auto overscroll-contain">
            {windowsList.map((win, index) => (
              <div key={win.id ?? index} className="flex items-center gap-2 px-3 py-2">
                <AppWindow className="size-3.5 shrink-0 text-muted-foreground/80" />
                <span className="min-w-0 flex-1 truncate text-foreground/90">{win.title || '无标题窗口'}</span>
                {win.id && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{win.id}</span>}
              </div>
            ))}
          </div>
        )
      ) : snapshotData ? (
        <div>
          {snapshotData.focusedLine && (
            <div className="flex items-center gap-2 border-b border-border/40 bg-blue-500/5 px-3 py-1.5 text-[11px]">
              <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-500 dark:text-blue-400">
                当前焦点
              </span>
              <span className="min-w-0 truncate text-foreground/85">{snapshotData.focusedLine}</span>
            </div>
          )}
          {snapshotData.nodes.length > 10 && (
            <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选控件、文本或引用…"
                aria-label="筛选界面控件"
                className="w-full min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              />
            </div>
          )}
          {filteredNodes.length === 0 ? (
            <div className="px-3 py-2.5">{filter.trim() ? '没有匹配的控件' : '未读取到界面控件'}</div>
          ) : (
            <div className="max-h-[min(18rem,45dvh)] overflow-auto overscroll-contain py-1 font-mono text-[11px] leading-relaxed">
              {filteredNodes.map((node) => (
                <div
                  key={node.key}
                  style={{ paddingLeft: `${10 + Math.min(node.depth, 10) * 14}px` }}
                  className={cn(
                    'flex items-center gap-2 pr-3 py-0.5 hover:bg-muted/30',
                    node.focused && 'bg-blue-500/5',
                    node.disabled && 'opacity-60',
                  )}
                >
                  <span className="shrink-0 rounded bg-muted/70 px-1.5 py-px font-sans text-[10px] text-muted-foreground">
                    {node.role}
                  </span>
                  {node.label && (
                    <span className="min-w-0 truncate font-sans text-xs text-foreground/90">{node.label}</span>
                  )}
                  {node.value && (
                    <span className="min-w-0 truncate text-muted-foreground">= {JSON.stringify(node.value)}</span>
                  )}
                  {node.disabled && (
                    <span className="shrink-0 rounded bg-muted/60 px-1 py-px font-sans text-[10px] text-muted-foreground">
                      已禁用
                    </span>
                  )}
                  {node.windowAction && <span className="shrink-0 font-sans text-muted-foreground">窗口操作</span>}
                  {node.focused && (
                    <span className="shrink-0 rounded bg-blue-500/15 px-1 py-px font-sans text-[10px] text-blue-500 dark:text-blue-400">
                      焦点
                    </span>
                  )}
                  {node.refId && (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/75">{node.refId}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 px-3 py-2.5">
          {info.isWrite && deliveryLabel && <div>{deliveryLabel}</div>}
          {info.isWrite && recovery && <div>{recovery}</div>}
          {info.ref && (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground/80">目标控件</span>
              {target && <span className="min-w-0 truncate text-foreground/90">{target}</span>}
              <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
                {info.ref}
              </span>
            </div>
          )}
          {info.key && (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground/80">按键组合</span>
              <div className="flex flex-wrap items-center gap-1">
                {info.key.split('+').map((part, idx) => (
                  <React.Fragment key={`${part}-${idx}`}>
                    {idx > 0 && <span className="text-muted-foreground/60">+</span>}
                    <kbd className="rounded border border-border/80 bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
                      {part}
                    </kbd>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          {info.text !== undefined && (
            <div className="flex items-start gap-2">
              <span className="w-14 shrink-0 pt-0.5 text-muted-foreground/80">输入内容</span>
              <pre className="min-w-0 flex-1 max-h-28 overflow-auto rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground/90 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {info.text}
              </pre>
            </div>
          )}
          {!info.ref && !info.key && info.text === undefined && !deliveryLabel && rawText && (
            <pre className="max-h-[min(12rem,30dvh)] overflow-auto font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {formattedRaw}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
