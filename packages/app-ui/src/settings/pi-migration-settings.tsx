import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Minus,
  MinusCircle,
  RefreshCw,
  ScanSearch,
} from 'lucide-react'
import type {
  DesktopPiMigration,
  PiMigrationApply,
  PiMigrationCategory,
  PiMigrationItem,
  PiMigrationResult,
  PiMigrationScan,
} from '@pi-meme/contracts/pi-migration'
import { FadeContent } from '@pi-meme/ui/components/fade-content'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'
import { OverflowTooltip, TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import type { SettingsSection } from './settings-page'

function migrationError(cause: unknown, fallback: string) {
  return cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method 'platform:pi-migration-(?:scan|apply)': Error: /, '')
    : fallback
}

const categoryLabels: Record<PiMigrationCategory, string> = {
  instruction: '指令',
  skill: '技能',
  prompt: '提示词',
  mcp: 'MCP',
  model: '模型',
  setting: 'Pi 设置',
  theme: '主题',
  shortcut: '快捷键',
  credential: '凭据',
}

const statusLabels: Record<PiMigrationItem['status'], string> = {
  new: '新增',
  conflict: '冲突',
  same: '相同',
  blocked: '无法导入',
}

const statusOrder: Record<PiMigrationItem['status'], number> = {
  conflict: 0,
  new: 1,
  blocked: 2,
  same: 3,
}

type FilterKey = 'all' | PiMigrationItem['status']

const filterLabels: Record<FilterKey, string> = {
  all: '全部',
  conflict: '冲突',
  new: '新增',
  blocked: '无法导入',
  same: '相同',
}

const categorySettingsTarget: Partial<Record<PiMigrationCategory, { section: SettingsSection; label: string }>> = {
  mcp: { section: 'mcp', label: '前往 MCP 授权' },
  model: { section: 'models', label: '查看模型设置' },
  skill: { section: 'skills', label: '查看技能' },
  instruction: { section: 'instructions', label: '查看指令' },
  theme: { section: 'appearance', label: '查看外观主题' },
  shortcut: { section: 'shortcuts', label: '查看快捷键' },
}

const smallText = 'text-xs leading-relaxed text-muted-foreground'

type Stage =
  | { name: 'entry' }
  | { name: 'preview' | 'confirm'; scan: PiMigrationScan }
  | { name: 'result'; source: string; result: PiMigrationResult }

function CheckBox({
  checked,
  indeterminate = false,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  onChange,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  ariaLabel?: string
  ariaDescribedBy?: string
  onChange: (value: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => onChange(event.target.checked)}
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4 items-center justify-center rounded-[5px] border transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-popover motion-reduce:transition-none',
          checked || indeterminate
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-transparent text-transparent peer-hover:border-foreground/35',
          disabled && 'opacity-45',
        )}
      >
        {indeterminate ? (
          <Minus className="size-3" strokeWidth={2.5} />
        ) : checked ? (
          <Check className="size-3" strokeWidth={2.5} />
        ) : null}
      </span>
    </span>
  )
}

function StatusBadge({ status }: { status: PiMigrationItem['status'] }) {
  if (status === 'new') {
    return (
      <Badge variant="success" className="px-1.5 py-0 text-[11px] font-medium">
        {statusLabels.new}
      </Badge>
    )
  }
  if (status === 'conflict') {
    return (
      <Badge variant="warning" className="px-1.5 py-0 text-[11px] font-medium">
        {statusLabels.conflict}
      </Badge>
    )
  }
  if (status === 'blocked') {
    return (
      <Badge
        variant="outline"
        className="border-destructive/30 bg-destructive/10 px-1.5 py-0 text-[11px] font-medium text-destructive"
      >
        {statusLabels.blocked}
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-normal text-muted-foreground">
      {statusLabels.same}
    </Badge>
  )
}

function diffHighlights(currentLines: string[], otherLines: string[]): Set<number> {
  if (!otherLines.length) return new Set()
  const m = currentLines.length
  const n = otherLines.length
  if (m * n > 40_000) {
    const changed = new Set<number>()
    let start = 0
    while (start < m && start < n && currentLines[start] === otherLines[start]) start++
    let end = 0
    while (end < m - start && end < n - start && currentLines[m - end - 1] === otherLines[n - end - 1]) end++
    for (let i = start; i < m - end; i++) changed.add(i)
    return changed
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = currentLines[i] === otherLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const matched = new Set<number>()
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (currentLines[i] === otherLines[j]) {
      matched.add(i)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  const changed = new Set<number>()
  for (let index = 0; index < m; index++) {
    if (!matched.has(index)) changed.add(index)
  }
  return changed
}

function DiffText({ content, other, incoming }: { content: string; other?: string; incoming: boolean }) {
  const lines = useMemo(() => (content || '（空）').split('\n'), [content])
  const changed = useMemo(() => diffHighlights(lines, other ? other.split('\n') : []), [lines, other])
  return (
    <pre className="max-h-60 min-w-0 overflow-auto rounded-lg border border-border/60 bg-muted/45 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap wrap-anywhere select-text">
      {lines.map((line, index) => (
        <span
          key={index}
          className={cn(
            'block min-h-[1lh] rounded-[3px] px-1 -mx-1',
            changed.has(index) && (incoming ? 'bg-[var(--color-success)]/15' : 'bg-destructive/15'),
          )}
        >
          {line}
        </span>
      ))}
    </pre>
  )
}

function StepIndicator({ current }: { current: 'preview' | 'confirm' | 'result' }) {
  const steps = [
    { id: 'preview', label: '选择配置' },
    { id: 'confirm', label: '确认导入' },
    { id: 'result', label: '完成' },
  ] as const
  const activeIndex = steps.findIndex((step) => step.id === current)
  return (
    <ol aria-label="迁移进度" className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none">
      {steps.map((step, index) => {
        const done = index < activeIndex
        const active = index === activeIndex
        return (
          <li key={step.id} aria-current={active ? 'step' : undefined} className="flex items-center gap-1.5">
            {index > 0 && <span aria-hidden="true" className="h-px w-3 bg-border" />}
            <span className={cn('inline-flex items-center gap-1', active && 'font-medium text-foreground')}>
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex size-4 items-center justify-center rounded-full text-[10px] tabular-nums',
                  done
                    ? 'bg-primary/15 text-primary'
                    : active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground',
                )}
              >
                {done ? <Check className="size-2.5" strokeWidth={2.5} /> : index + 1}
              </span>
              {step.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ConflictToggle({
  name,
  replace,
  onChange,
}: {
  name: string
  replace: boolean
  onChange: (replace: boolean) => void
}) {
  return (
    <div
      role="group"
      aria-label={`${name} 的冲突处理`}
      className="inline-flex shrink-0 items-center rounded-lg border border-border/80 bg-secondary/45 p-0.5 text-[11px]"
    >
      <button
        type="button"
        aria-pressed={!replace}
        onClick={() => onChange(false)}
        className={cn(
          'cursor-pointer rounded-md px-2 py-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none',
          !replace ? 'bg-popover font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        保留现有
      </button>
      <button
        type="button"
        aria-pressed={replace}
        onClick={() => onChange(true)}
        className={cn(
          'cursor-pointer rounded-md px-2 py-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none',
          replace
            ? 'bg-amber-500/20 font-medium text-amber-700 dark:text-amber-300'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        覆盖现有
      </button>
    </div>
  )
}

function PreviewRow({
  item,
  selected,
  expanded,
  onSelect,
  onExpand,
}: {
  item: PiMigrationItem
  selected: boolean
  expanded: boolean
  onSelect: (value: boolean) => void
  onExpand: () => void
}) {
  const diffId = `pi-migration-diff-${encodeURIComponent(item.id)}`
  const hasContent = item.before !== undefined || item.after !== undefined
  const expandLabel = item.status === 'conflict' ? '对比' : '预览'
  const willReplace = item.status === 'conflict' && selected
  return (
    <li className={cn(willReplace && 'bg-amber-500/[0.04]')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 basis-52 items-start gap-2.5">
          {item.status === 'new' ? (
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
              <span className="pt-0.5">
                <CheckBox checked={selected} ariaLabel={`导入 ${item.name}`} onChange={onSelect} />
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground wrap-anywhere">{item.name}</span>
                  <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {categoryLabels[item.category]}
                  </span>
                  <StatusBadge status={item.status} />
                </span>
                {item.note && <span className={cn(smallText, 'block wrap-anywhere')}>{item.note}</span>}
              </span>
            </label>
          ) : (
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'font-medium wrap-anywhere',
                      item.status === 'same' ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {item.name}
                  </span>
                  <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {categoryLabels[item.category]}
                  </span>
                  <StatusBadge status={item.status} />
                </div>
                {item.note && (
                  <p className={cn(smallText, 'wrap-anywhere', item.status === 'blocked' && 'text-destructive/90')}>
                    {item.note}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="ml-6 flex shrink-0 items-center gap-2 @min-[520px]/settings:ml-0">
          {item.status === 'conflict' && <ConflictToggle name={item.name} replace={selected} onChange={onSelect} />}
          {hasContent && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`查看 ${item.name} 的${expandLabel}`}
              aria-expanded={expanded}
              aria-controls={expanded ? diffId : undefined}
              className="h-7 gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onExpand}
            >
              {expandLabel}
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                  expanded && 'rotate-180',
                )}
              />
            </Button>
          )}
        </div>
      </div>
      {hasContent && expanded && (
        <div className="space-y-2 border-t border-border/40 bg-secondary/20 px-4 py-3" id={diffId}>
          {item.source !== item.name && (
            <p className="font-mono text-[11px] wrap-anywhere text-muted-foreground">来源：{item.source}</p>
          )}
          {item.status === 'same' ? (
            <div className="space-y-1.5">
              <p className={smallText}>来源与当前配置内容一致。</p>
              {item.after !== undefined && <DiffText content={item.after} incoming={false} />}
            </div>
          ) : item.status === 'conflict' && item.before === item.after ? (
            <p className={smallText}>配置有差异，差异部分超出预览截断范围。</p>
          ) : (
            <div className="grid min-w-0 gap-2.5 @min-[560px]/settings:grid-cols-2">
              {item.before !== undefined && (
                <div className="min-w-0 space-y-1">
                  <p className={cn(smallText, 'font-medium')}>Pi meme 现有</p>
                  <DiffText content={item.before} other={item.after} incoming={false} />
                </div>
              )}
              {item.after !== undefined && (
                <div
                  className={cn('min-w-0 space-y-1', item.before === undefined && '@min-[560px]/settings:col-span-2')}
                >
                  <p className={cn(smallText, 'font-medium')}>{item.status === 'new' ? '将导入内容' : '本地 Pi'}</p>
                  <DiffText content={item.after} other={item.before} incoming />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function ResultList({
  result,
  onNavigateSettings,
}: {
  result: PiMigrationResult
  onNavigateSettings?: (section: SettingsSection) => void
}) {
  const [showSkipped, setShowSkipped] = useState(false)
  const [copiedBackup, setCopiedBackup] = useState(false)
  const copyTimer = useRef<number>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const failed = result.items.filter((item) => item.status === 'failed')
  const imported = result.items.filter((item) => item.status === 'imported')
  const skipped = result.items.filter((item) => item.status === 'skipped')

  const nextLinks = useMemo(() => {
    if (!onNavigateSettings) return []
    const seen = new Set<SettingsSection>()
    const links: Array<{ section: SettingsSection; label: string }> = []
    for (const item of imported) {
      const target =
        categorySettingsTarget[item.category] ??
        (item.id.startsWith('credential:mcp:') ? categorySettingsTarget.mcp : undefined)
      if (target && !seen.has(target.section)) {
        seen.add(target.section)
        links.push(target)
      }
    }
    if (
      !seen.has('models') &&
      result.items.some((item) => item.category === 'credential' && item.id.startsWith('credential:oauth:'))
    ) {
      links.push({ section: 'models', label: '在模型设置中登录 OAuth' })
    }
    return links
  }, [imported, onNavigateSettings, result.items])

  async function copyBackupPath() {
    if (!result.backupDirectory) return
    try {
      await navigator.clipboard.writeText(result.backupDirectory)
      setCopiedBackup(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(setCopiedBackup, 1800, false)
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  }

  const summaryTone =
    failed.length > 0 || result.refreshError
      ? 'border-amber-500/30 bg-amber-500/[0.06]'
      : 'border-emerald-500/25 bg-emerald-500/[0.06]'

  return (
    <div className="space-y-4">
      <div role="status" className={cn('rounded-xl border px-4 py-3', summaryTone)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {failed.length > 0 ? (
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-amber-500" />
            ) : (
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-500" />
            )}
            <span className="font-medium text-foreground">
              {failed.length > 0 ? '迁移已完成，部分项目导入失败' : '迁移已完成'}
            </span>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            已导入 {imported.length} · 已跳过 {skipped.length} · 失败 {failed.length}
          </span>
        </div>
        {result.refreshError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {result.refreshError}
          </p>
        )}
      </div>

      {nextLinks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {nextLinks.map((link) => (
            <Button
              key={link.section}
              type="button"
              variant="outline"
              size="xs"
              className="h-7 gap-1 rounded-lg px-2.5 text-[11px]"
              onClick={() => onNavigateSettings?.(link.section)}
            >
              {link.label}
              <ExternalLink className="size-3 text-muted-foreground" />
            </Button>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <SettingsGroup
          title={`失败（${failed.length}）`}
          action={<CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />}
        >
          <SettingsCard>
            {failed.map((item) => (
              <SettingsRow key={item.id} className="items-start py-2.5">
                <div className="min-w-0 flex-1 basis-40 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium wrap-anywhere">{item.name}</span>
                    <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {categoryLabels[item.category]}
                    </span>
                  </div>
                  <p className="text-xs text-destructive wrap-anywhere">{item.message}</p>
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsGroup>
      )}

      {imported.length > 0 && (
        <SettingsGroup
          title={`已导入（${imported.length}）`}
          action={<CircleCheck aria-hidden="true" className="size-3.5 text-emerald-500" />}
        >
          <SettingsCard>
            {imported.map((item) => (
              <SettingsRow key={item.id} className="items-center py-2">
                <div className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-1.5">
                  <span className="font-medium wrap-anywhere">{item.name}</span>
                  <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {categoryLabels[item.category]}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{item.message}</span>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsGroup>
      )}

      {skipped.length > 0 && (
        <SettingsGroup
          title={`已跳过（${skipped.length}）`}
          action={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={showSkipped}
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowSkipped((value) => !value)}
            >
              {showSkipped ? '收起' : '展开'}
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                  showSkipped && 'rotate-180',
                )}
              />
            </Button>
          }
        >
          {showSkipped && (
            <SettingsCard>
              {skipped.map((item) => (
                <SettingsRow key={item.id} className="items-center py-2">
                  <div className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-1.5">
                    <MinusCircle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <span className="text-muted-foreground wrap-anywhere">{item.name}</span>
                    <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {categoryLabels[item.category]}
                    </span>
                  </div>
                  <span className="min-w-0 text-xs text-muted-foreground wrap-anywhere">{item.message}</span>
                </SettingsRow>
              ))}
            </SettingsCard>
          )}
        </SettingsGroup>
      )}

      {result.backupDirectory && (
        <SettingsCard className="divide-y-0 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">覆盖前已自动备份</p>
              <OverflowTooltip content={result.backupDirectory}>
                <code className="block truncate font-mono text-[11px] text-foreground/85 select-text">
                  {result.backupDirectory}
                </code>
              </OverflowTooltip>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-7 gap-1 rounded-md px-2 text-[11px]"
              onClick={() => void copyBackupPath()}
            >
              {copiedBackup ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
              {copiedBackup ? '已复制' : '复制路径'}
            </Button>
          </div>
        </SettingsCard>
      )}
    </div>
  )
}

export function PiMigrationSettings({
  adapter,
  hostId,
  onApplying,
  onShortcutsChanged,
  onNavigateSettings,
  onSubpageChange,
  children,
}: {
  adapter: DesktopPiMigration
  hostId: string
  onApplying: (value: boolean) => void
  onShortcutsChanged: () => Promise<void>
  onNavigateSettings?: (section: SettingsSection) => void
  onSubpageChange?: (active: boolean) => void
  children: (entry: ReactNode) => ReactNode
}) {
  const [stage, setStage] = useState<Stage>({ name: 'entry' })
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<FilterKey>('all')
  const [showSameInAll, setShowSameInAll] = useState(false)
  const [expanded, setExpanded] = useState<string>()
  const [working, setWorking] = useState<'scan' | 'apply'>()
  const [error, setError] = useState('')
  const [emptySource, setEmptySource] = useState('')
  const rootRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const scanRef = useRef<HTMLButtonElement>(null)
  const focusNext = useRef(false)
  const running = useRef(false)
  const scanSeq = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onSubpageChange?.(false)
    }
  }, [onSubpageChange])

  useEffect(() => {
    onSubpageChange?.(stage.name !== 'entry')
  }, [onSubpageChange, stage.name])

  function show(next: Stage) {
    focusNext.current = true
    setStage(next)
  }

  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    if (stage.name === 'entry') {
      scanRef.current?.focus()
    } else {
      rootRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      headingRef.current?.focus({ preventScroll: true })
    }
  }, [stage])

  const scan = stage.name === 'preview' || stage.name === 'confirm' ? stage.scan : undefined
  const items = useMemo(() => scan?.items ?? [], [scan])
  const rows = useMemo(
    () =>
      items
        .filter(({ category }) => category !== 'credential')
        .sort((left, right) => statusOrder[left.status] - statusOrder[right.status]),
    [items],
  )
  const credentials = useMemo(() => items.filter(({ category }) => category === 'credential'), [items])
  const lookup = useMemo(() => new Map(rows.map((item) => [item.id, item])), [rows])

  const selected = useMemo(() => items.filter(({ id }) => selection.has(id)), [items, selection])
  const ordinary = useMemo(() => selected.filter(({ category }) => category !== 'credential'), [selected])
  const selectedCredentials = useMemo(() => selected.filter(({ category }) => category === 'credential'), [selected])
  const selectedNewCount = useMemo(() => ordinary.filter(({ status }) => status === 'new').length, [ordinary])
  const selectedConflictCount = useMemo(() => ordinary.filter(({ status }) => status === 'conflict').length, [ordinary])

  const additions = useMemo(() => rows.filter(({ status }) => status === 'new'), [rows])
  const conflicts = useMemo(() => rows.filter(({ status }) => status === 'conflict'), [rows])
  const sameRows = useMemo(() => rows.filter(({ status }) => status === 'same'), [rows])
  const blockedRows = useMemo(() => rows.filter(({ status }) => status === 'blocked'), [rows])

  const allAdditionsSelected = additions.length > 0 && selectedNewCount === additions.length
  const someAdditionsSelected = selectedNewCount > 0 && selectedNewCount < additions.length
  const allConflictsReplaced = conflicts.length > 0 && selectedConflictCount === conflicts.length

  const activeFilter: FilterKey = useMemo(() => {
    if (filter === 'all') return 'all'
    const counts: Record<PiMigrationItem['status'], number> = {
      conflict: conflicts.length,
      new: additions.length,
      blocked: blockedRows.length,
      same: sameRows.length,
    }
    return counts[filter] > 0 ? filter : 'all'
  }, [additions.length, blockedRows.length, conflicts.length, filter, sameRows.length])

  const primaryRows = useMemo(() => {
    if (activeFilter !== 'all') return rows.filter((item) => item.status === activeFilter)
    const actionable = rows.filter((item) => item.status !== 'same')
    return actionable.length > 0 ? actionable : rows
  }, [activeFilter, rows])

  const hasCollapsedSame = activeFilter === 'all' && sameRows.length > 0 && rows.length > sameRows.length

  const filterOptions = useMemo(() => {
    const candidates: Array<{ key: FilterKey; count: number }> = [
      { key: 'all', count: rows.length },
      { key: 'conflict', count: conflicts.length },
      { key: 'new', count: additions.length },
      { key: 'blocked', count: blockedRows.length },
      { key: 'same', count: sameRows.length },
    ]
    const nonEmptyStatusCount = candidates.slice(1).filter((entry) => entry.count > 0).length
    if (nonEmptyStatusCount <= 1) return []
    return candidates.filter((entry) => entry.key === 'all' || entry.count > 0)
  }, [additions.length, blockedRows.length, conflicts.length, rows.length, sameRows.length])

  function updateSelection(ids: string[], checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      for (const credential of credentials) {
        if (credential.requires && lookup.get(credential.requires)?.status !== 'same' && !next.has(credential.requires))
          next.delete(credential.id)
      }
      return next
    })
  }

  async function scanSource() {
    if (running.current) return
    const currentScan = ++scanSeq.current
    running.current = true
    setWorking('scan')
    setError('')
    setEmptySource('')
    try {
      const next = await adapter.scan(hostId)
      if (!mounted.current || scanSeq.current !== currentScan) return
      if (!next.items.length) {
        setEmptySource(next.source)
        show({ name: 'entry' })
        return
      }
      setSelection(
        new Set(
          next.items
            .filter(({ status, category }) => status === 'new' && category !== 'credential')
            .map(({ id }) => id),
        ),
      )
      setFilter('all')
      setShowSameInAll(false)
      setExpanded(next.items.find(({ status }) => status === 'conflict')?.id)
      show({ name: 'preview', scan: next })
    } catch (cause) {
      if (mounted.current && scanSeq.current === currentScan)
        setError(migrationError(cause, '无法扫描 Pi 配置，请重试'))
    } finally {
      if (scanSeq.current === currentScan) {
        running.current = false
        if (mounted.current) setWorking(undefined)
      }
    }
  }

  function cancelPendingScan() {
    scanSeq.current += 1
    if (working === 'scan') {
      running.current = false
      setWorking(undefined)
    }
  }

  async function apply() {
    if (stage.name !== 'confirm' || working === 'apply' || !selected.length) return
    cancelPendingScan()
    const { scan: activeScan } = stage
    const request: PiMigrationApply = {
      revision: activeScan.revision,
      itemIds: ordinary.map(({ id }) => id),
      credentialIds: selectedCredentials.map(({ id }) => id),
    }
    running.current = true
    setWorking('apply')
    onApplying(true)
    setError('')
    try {
      const result = await adapter.apply(hostId, request)
      if (result.items.some(({ category, status }) => category === 'shortcut' && status === 'imported'))
        await onShortcutsChanged()
      if (mounted.current) show({ name: 'result', source: activeScan.source, result })
    } catch (cause) {
      if (mounted.current) setError(migrationError(cause, '无法确认导入结果，请重新扫描'))
    } finally {
      running.current = false
      onApplying(false)
      if (mounted.current) setWorking(undefined)
    }
  }

  const errorMessage = error && (
    <div
      role="alert"
      className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive wrap-anywhere"
    >
      {error}
    </div>
  )

  const entry = (
    <SettingsGroup title="导入与迁移">
      <SettingsCard>
        <SettingsRow>
          <div className="min-w-0 space-y-0.5">
            <h4 className="font-medium">从本地 Pi 迁移</h4>
            <p className={smallText}>扫描并选择性导入 Pi CLI 的用户级指令、技能、MCP、模型、主题与快捷键。</p>
          </div>
          <Button
            ref={scanRef}
            type="button"
            variant="secondary"
            size="sm"
            className={settingsControlClassName}
            disabled={Boolean(working)}
            onClick={() => void scanSource()}
          >
            {working === 'scan' ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <ScanSearch className="size-3.5" />
            )}
            {working === 'scan' ? '正在扫描…' : emptySource || error ? '重新扫描' : '扫描配置'}
          </Button>
        </SettingsRow>
        {(emptySource || error) && (
          <div className="space-y-2 px-4 py-3">
            {emptySource && (
              <p role="status" className={cn(smallText, 'wrap-anywhere')}>
                在 <code className="font-mono text-foreground/85 select-text">{emptySource}</code> 未找到可迁移的 Pi
                用户配置。
              </p>
            )}
            {errorMessage}
          </div>
        )}
      </SettingsCard>
    </SettingsGroup>
  )

  if (stage.name === 'entry') return children(entry)

  const source = stage.name === 'result' ? stage.source : stage.scan.source
  const hasMcpSelected = selected.some(({ category, id }) => category === 'mcp' || id.startsWith('credential:mcp:'))
  const selectionSummaryParts = [
    selectedNewCount > 0 ? `新增 ${selectedNewCount}` : '',
    selectedConflictCount > 0 ? `覆盖 ${selectedConflictCount}` : '',
    selectedCredentials.length > 0 ? `凭据 ${selectedCredentials.length}` : '',
  ].filter(Boolean)

  return (
    <section ref={rootRef} className="min-w-0 space-y-5" aria-labelledby="settings-section-title">
      <div className="space-y-3 border-b border-border/70 pb-3.5">
        <div className="flex min-w-0 items-center gap-2 pr-10">
          {stage.name === 'preview' && (
            <TooltipHint content="返回常规设置">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="返回常规"
                onClick={() => {
                  cancelPendingScan()
                  setError('')
                  show({ name: 'entry' })
                }}
              >
                <ArrowLeft className="size-4" />
              </Button>
            </TooltipHint>
          )}
          {stage.name === 'confirm' && (
            <TooltipHint content="返回导入预览">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="返回预览"
                disabled={working === 'apply'}
                onClick={() => {
                  cancelPendingScan()
                  setError('')
                  show({ name: 'preview', scan: stage.scan })
                }}
              >
                <ArrowLeft className="size-4" />
              </Button>
            </TooltipHint>
          )}
          <h2
            id="settings-section-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-semibold tracking-tight outline-none sm:text-2xl"
          >
            从本地 Pi 迁移
          </h2>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StepIndicator current={stage.name} />
          {stage.name === 'preview' && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-7 gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
              disabled={working === 'scan'}
              onClick={() => void scanSource()}
            >
              <RefreshCw className={cn('size-3', working === 'scan' && 'animate-spin motion-reduce:animate-none')} />
              {working === 'scan' ? '扫描中…' : '重新扫描'}
            </Button>
          )}
        </div>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="shrink-0">来源</dt>
            <dd className="min-w-0">
              <OverflowTooltip content={source}>
                <code className="block max-w-[24rem] truncate font-mono text-foreground/85 select-text">{source}</code>
              </OverflowTooltip>
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="shrink-0">目标</dt>
            <dd className="text-foreground/85">此电脑的 Pi meme</dd>
          </div>
        </dl>
      </div>

      {stage.name === 'preview' && (
        <FadeContent key="preview" className="space-y-4">
          {errorMessage}
          {rows.length > 0 && (
            <SettingsCard className="divide-y-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-secondary/35 px-3.5 py-2">
                <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="按状态筛选配置">
                  {filterOptions.length > 0 ? (
                    filterOptions.map(({ key, count }) => {
                      const active = activeFilter === key
                      return (
                        <button
                          key={key}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setFilter(key)}
                          className={cn(
                            'cursor-pointer rounded-md px-2 py-1 text-[11px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none',
                            active
                              ? 'bg-popover font-medium text-foreground shadow-xs'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {filterLabels[key]}
                          <span className="ml-1 text-[10px] opacity-75 tabular-nums">{count}</span>
                        </button>
                      )
                    })
                  ) : (
                    <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                      共 {rows.length} 项配置
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {additions.length > 0 && (
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-foreground select-none">
                      <CheckBox
                        checked={allAdditionsSelected}
                        indeterminate={someAdditionsSelected}
                        onChange={(checked) =>
                          updateSelection(
                            additions.map(({ id }) => id),
                            checked,
                          )
                        }
                      />
                      全选新增
                    </label>
                  )}
                  {conflicts.length >= 2 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        updateSelection(
                          conflicts.map(({ id }) => id),
                          !allConflictsReplaced,
                        )
                      }
                    >
                      {allConflictsReplaced ? '冲突全保留' : '冲突全覆盖'}
                    </Button>
                  )}
                </div>
              </div>
              <ul className="divide-y divide-border/40" aria-label="可迁移配置">
                {primaryRows.map((item) => (
                  <PreviewRow
                    key={item.id}
                    item={item}
                    selected={selection.has(item.id)}
                    expanded={expanded === item.id}
                    onSelect={(value) => updateSelection([item.id], value)}
                    onExpand={() => setExpanded(expanded === item.id ? undefined : item.id)}
                  />
                ))}
              </ul>
              {hasCollapsedSame && (
                <div className="border-t border-border/50">
                  <button
                    type="button"
                    aria-expanded={showSameInAll}
                    onClick={() => setShowSameInAll((value) => !value)}
                    className="flex w-full cursor-pointer items-center justify-between px-3.5 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span>另有 {sameRows.length} 项与现有配置一致</span>
                    <span className="inline-flex items-center gap-1">
                      {showSameInAll ? '收起' : '展开查看'}
                      <ChevronDown
                        className={cn(
                          'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                          showSameInAll && 'rotate-180',
                        )}
                      />
                    </span>
                  </button>
                  {showSameInAll && (
                    <ul className="divide-y divide-border/40 border-t border-border/40" aria-label="内容相同的配置">
                      {sameRows.map((item) => (
                        <PreviewRow
                          key={item.id}
                          item={item}
                          selected={false}
                          expanded={expanded === item.id}
                          onSelect={() => {}}
                          onExpand={() => setExpanded(expanded === item.id ? undefined : item.id)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </SettingsCard>
          )}

          {credentials.length > 0 && (
            <SettingsGroup
              title="凭据与私有参数"
              action={
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <KeyRound aria-hidden="true" className="size-3" />
                  默认不勾选，已有凭据自动保留
                </span>
              }
            >
              <SettingsCard>
                {credentials.map((item) => {
                  const requirement = item.requires ? lookup.get(item.requires) : undefined
                  const requirementBlocked = Boolean(item.requires && requirement?.status === 'blocked')
                  const needsSelectRequirement = Boolean(
                    item.status === 'new' &&
                    item.requires &&
                    requirement &&
                    requirement.status !== 'same' &&
                    requirement.status !== 'blocked' &&
                    !selection.has(item.requires),
                  )
                  const eligible = item.status === 'new' && !requirementBlocked && !needsSelectRequirement
                  const hint = requirementBlocked
                    ? `对应的 ${requirement?.name ?? '服务'} 配置无法导入，无法单独导入此凭据。`
                    : needsSelectRequirement
                      ? `需先${requirement?.status === 'conflict' ? '选择覆盖' : '勾选'} ${requirement?.name ?? '对应服务'} 的配置。`
                      : (item.note ?? '写入本机加密凭据存储，保留已有凭据。')
                  const hintId = `pi-migration-note-${encodeURIComponent(item.id)}`
                  const canImport = item.status === 'new' && !requirementBlocked

                  return (
                    <SettingsRow key={item.id} className="items-start gap-2.5 py-2.5">
                      {canImport ? (
                        <label
                          className={cn(
                            'flex min-w-0 flex-1 items-start gap-2.5',
                            eligible ? 'cursor-pointer' : 'cursor-not-allowed',
                          )}
                        >
                          <span className="pt-0.5">
                            <CheckBox
                              checked={selection.has(item.id)}
                              disabled={!eligible}
                              ariaDescribedBy={hintId}
                              onChange={(checked) => updateSelection([item.id], checked)}
                            />
                          </span>
                          <span className="min-w-0 flex-1 space-y-0.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className={cn('font-medium wrap-anywhere', !eligible && 'text-muted-foreground')}>
                                {item.name}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">{item.source}</span>
                            </span>
                            <span id={hintId} className={cn(smallText, 'block wrap-anywhere')}>
                              {hint}
                            </span>
                          </span>
                        </label>
                      ) : (
                        <div className="flex min-w-0 flex-1 items-start gap-2.5">
                          <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-muted-foreground wrap-anywhere">{item.name}</span>
                              <StatusBadge status={requirementBlocked ? 'blocked' : item.status} />
                            </div>
                            <p id={hintId} className={cn(smallText, 'wrap-anywhere')}>
                              {hint}
                            </p>
                          </div>
                        </div>
                      )}
                      {needsSelectRequirement && requirement && (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="h-7 shrink-0 rounded-md px-2 text-[11px]"
                          onClick={() => updateSelection([requirement.id, item.id], true)}
                        >
                          {requirement.status === 'conflict' ? '覆盖并导入' : '一并勾选'}
                        </Button>
                      )}
                    </SettingsRow>
                  )
                })}
              </SettingsCard>
            </SettingsGroup>
          )}

          <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-popover/95 px-3.5 py-2.5 shadow-sm backdrop-blur-sm">
            <p role="status" className="text-xs text-muted-foreground tabular-nums">
              {selectionSummaryParts.length > 0 ? (
                <>
                  已选 <span className="font-medium text-foreground">{selected.length}</span> 项（
                  {selectionSummaryParts.join(' · ')}）
                </>
              ) : (
                '请选择要导入的配置'
              )}
            </p>
            <Button
              type="button"
              size="sm"
              className={settingsControlClassName}
              disabled={!selected.length}
              onClick={() => {
                cancelPendingScan()
                show({ name: 'confirm', scan: stage.scan })
              }}
            >
              下一步 <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </FadeContent>
      )}

      {stage.name === 'confirm' && (
        <FadeContent key="confirm" className="space-y-4">
          <SettingsCard>
            {(
              [
                ['新增', ordinary.filter(({ status }) => status === 'new'), 'success'],
                ['覆盖现有', ordinary.filter(({ status }) => status === 'conflict'), 'warning'],
                ['凭据与私有参数', selectedCredentials, 'secondary'],
              ] as const
            ).map(
              ([label, group, badgeVariant]) =>
                group.length > 0 && (
                  <div key={label} className="space-y-2 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={badgeVariant} className="px-2 py-0 text-[11px] font-medium">
                        {label}
                      </Badge>
                      <span className="text-xs text-muted-foreground tabular-nums">{group.length} 项</span>
                    </div>
                    <ul className="flex flex-wrap gap-1.5">
                      {group.map((entry) => (
                        <li
                          key={entry.id}
                          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-secondary/45 px-2 py-1 text-xs"
                        >
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {categoryLabels[entry.category]}
                          </span>
                          <span className="truncate font-medium text-foreground">{entry.name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
          </SettingsCard>

          {(selectedConflictCount > 0 || hasMcpSelected) && (
            <div className="space-y-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs text-foreground/90">
              {selectedConflictCount > 0 && (
                <p className="flex items-start gap-2">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  <span>
                    本次将覆盖 {selectedConflictCount} 项现有配置；覆盖前会自动备份现有内容，已有凭据不会被覆盖。
                  </span>
                </p>
              )}
              {hasMcpSelected && (
                <p className={cn(smallText, selectedConflictCount > 0 && 'pl-5.5')}>
                  导入的 MCP 服务需在「设置 → MCP」中重新授权后才会对 Agent 生效。
                </p>
              )}
            </div>
          )}

          {errorMessage}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={settingsControlClassName}
              disabled={working === 'apply'}
              onClick={() => {
                cancelPendingScan()
                setError('')
                show({ name: 'preview', scan: stage.scan })
              }}
            >
              <ArrowLeft className="size-3.5" /> 返回预览
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {error && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={settingsControlClassName}
                  disabled={Boolean(working)}
                  onClick={() => void scanSource()}
                >
                  <RefreshCw
                    className={cn('size-3.5', working === 'scan' && 'animate-spin motion-reduce:animate-none')}
                  />
                  {working === 'scan' ? '扫描中…' : '重新扫描'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                className={settingsControlClassName}
                disabled={working === 'apply' || !selected.length}
                onClick={() => void apply()}
              >
                {working === 'apply' && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />}
                {working === 'apply' ? '正在导入…' : `确认导入 ${selected.length} 项`}
              </Button>
            </div>
          </div>
        </FadeContent>
      )}

      {stage.name === 'result' && (
        <FadeContent key="result" className="space-y-4">
          <ResultList result={stage.result} onNavigateSettings={onNavigateSettings} />
          {errorMessage}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={settingsControlClassName}
              disabled={working === 'scan'}
              onClick={() => void scanSource()}
            >
              {working === 'scan' ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {working === 'scan' ? '正在扫描…' : '重新扫描'}
            </Button>
            <Button
              type="button"
              size="sm"
              className={settingsControlClassName}
              onClick={() => {
                cancelPendingScan()
                setError('')
                show({ name: 'entry' })
              }}
            >
              完成
            </Button>
          </div>
        </FadeContent>
      )}
    </section>
  )
}
