import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  KeyRound,
  MinusCircle,
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
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { cn } from '@pi-meme/ui/lib/utils'

function migrationError(cause: unknown, fallback: string) {
  return cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method 'platform:pi-migration-(?:scan|apply)': Error: /, '')
    : fallback
}

const labels: Record<PiMigrationCategory, string> = {
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
const statusLabels = { new: '新增', conflict: '冲突', same: '相同', blocked: '无法导入' }
const checkboxClass = 'size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring'
const smallText = 'text-xs leading-relaxed text-muted-foreground'

type Stage =
  | { name: 'entry' }
  | { name: 'preview' | 'confirm'; scan: PiMigrationScan }
  | { name: 'result'; source: string; result: PiMigrationResult }

function DiffText({ content, other, incoming }: { content: string; other?: string; incoming: boolean }) {
  const lines = (content || '（空）').split('\n')
  const previous = other?.split('\n') ?? []
  let start = 0
  while (start < lines.length && lines[start] === previous[start]) start++
  let end = 0
  while (
    end < lines.length - start &&
    end < previous.length - start &&
    lines[lines.length - end - 1] === previous[previous.length - end - 1]
  )
    end++
  return (
    <pre className="min-w-0 rounded-lg border border-border/60 bg-muted/45 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere select-text">
      {lines.map((line, index) => (
        <span
          key={index}
          className={cn(
            'block min-h-[1lh]',
            previous.length > 0 &&
              index >= start &&
              index < lines.length - end &&
              (incoming ? 'bg-[var(--color-success)]/15' : 'bg-destructive/15'),
          )}
        >
          {line}
        </span>
      ))}
    </pre>
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
  const hasDiff = item.before !== undefined || item.after !== undefined
  return (
    <li>
      <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-1.5 @min-[530px]/settings:grid-cols-[minmax(0,1fr)_minmax(7.5rem,auto)_auto]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex w-4 shrink-0 items-center justify-center">
            {item.status === 'new' && (
              <input
                type="checkbox"
                className={checkboxClass}
                checked={selected}
                aria-label={`导入 ${item.name}`}
                onChange={(event) => onSelect(event.target.checked)}
              />
            )}
          </span>
          <span className="hidden w-14 shrink-0 text-muted-foreground @min-[530px]/settings:inline">
            {labels[item.category]}
          </span>
          <div className="min-w-0 wrap-anywhere">
            <p className="font-medium">{item.name}</p>
            <p className={cn(smallText, '@min-[530px]/settings:hidden')}>{labels[item.category]}</p>
          </div>
        </div>
        <div className="col-start-1 row-start-2 ml-6 flex flex-wrap items-center gap-2 @min-[530px]/settings:col-start-2 @min-[530px]/settings:row-start-1 @min-[530px]/settings:ml-0">
          <span
            className={cn(
              'whitespace-nowrap',
              item.status === 'new'
                ? 'text-primary'
                : item.status === 'conflict'
                  ? 'font-medium'
                  : 'text-muted-foreground',
            )}
          >
            {statusLabels[item.status]}
          </span>
          {item.status === 'conflict' && (
            <select
              className="h-8 max-w-full rounded-lg border border-border bg-popover px-1.5 text-xs focus-visible:outline-ring"
              aria-label={`${item.name} 的冲突处理`}
              value={selected ? 'replace' : 'keep'}
              onChange={(event) => onSelect(event.target.value === 'replace')}
            >
              <option value="keep">保留现有</option>
              <option value="replace">覆盖现有</option>
            </select>
          )}
        </div>
        <div className="col-start-2 row-span-2 row-start-1 flex justify-end @min-[530px]/settings:col-start-3 @min-[530px]/settings:row-span-1">
          {hasDiff && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`查看 ${item.name} 的差异`}
              aria-expanded={expanded}
              aria-controls={expanded ? diffId : undefined}
              className={settingsControlClassName}
              onClick={onExpand}
            >
              差异 <ChevronDown className={cn(expanded && 'rotate-180')} />
            </Button>
          )}
        </div>
        {item.note && <p className={cn(smallText, 'col-span-full ml-6 wrap-anywhere')}>{item.note}</p>}
      </div>
      {hasDiff && expanded && (
        <div className="space-y-2 px-3 pt-0.5 pb-3" id={diffId}>
          {item.source !== item.name && <p className="font-mono wrap-anywhere text-muted-foreground">{item.source}</p>}
          {item.status === 'same' ? (
            <p className={smallText}>来源与现有配置一致。</p>
          ) : item.status === 'conflict' && item.before === item.after ? (
            <p className={smallText}>配置有差异，差异部分超出预览范围。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {item.before !== undefined && (
                <div className="min-w-0 flex-[1_1_12rem] space-y-1">
                  <p className={smallText}>Pi meme 现有</p>
                  <DiffText content={item.before} other={item.after} incoming={false} />
                </div>
              )}
              {item.after !== undefined && (
                <div className="min-w-0 flex-[1_1_12rem] space-y-1">
                  <p className={smallText}>{item.status === 'new' ? '将导入' : '本地 Pi'}</p>
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

function ResultList({ result }: { result: PiMigrationResult }) {
  const groups = [
    { status: 'failed', title: '失败', icon: CircleAlert, tone: 'text-destructive' },
    { status: 'imported', title: '已导入', icon: CircleCheck, tone: 'text-primary' },
    { status: 'skipped', title: '已跳过', icon: MinusCircle, tone: 'text-muted-foreground' },
  ] as const
  const [failed, imported, skipped] = groups.map((group) => result.items.filter((item) => item.status === group.status))
  return (
    <div className="space-y-3">
      <p role="status" className={cn(smallText, 'tabular-nums')}>
        已导入 {imported.length} 项 · 已跳过 {skipped.length} 项 · 失败 {failed.length} 项
      </p>
      {result.refreshError && (
        <p role="alert" className="text-destructive">
          {result.refreshError}
        </p>
      )}
      {groups.map(({ status, title, icon: Icon, tone }, index) => {
        const items = [failed, imported, skipped][index]
        if (!items.length) return null
        return (
          <SettingsGroup
            key={status}
            title={title}
            action={<Icon aria-hidden="true" className={cn('size-3.5', tone)} />}
          >
            <SettingsCard>
              {items.map((item) => (
                <SettingsRow key={item.id} className="items-start py-2">
                  <div className="min-w-0 flex-1 basis-32 wrap-anywhere">
                    <span className="mr-2 text-muted-foreground">{labels[item.category]}</span>
                    <span className="font-medium">{item.name}</span>
                  </div>
                  <p className={cn('min-w-0 wrap-anywhere', status === 'failed' ? tone : 'text-muted-foreground')}>
                    {item.message}
                  </p>
                </SettingsRow>
              ))}
            </SettingsCard>
          </SettingsGroup>
        )
      })}
      {result.backupDirectory && (
        <p className={cn(smallText, 'wrap-anywhere')}>
          备份位置 <code className="font-mono select-text">{result.backupDirectory}</code>
        </p>
      )}
    </div>
  )
}

export function PiMigrationSettings({
  adapter,
  hostId,
  onApplying,
  onShortcutsChanged,
  children,
}: {
  adapter: DesktopPiMigration
  hostId: string
  onApplying: (value: boolean) => void
  onShortcutsChanged: () => Promise<void>
  children: (entry: ReactNode) => ReactNode
}) {
  const [stage, setStage] = useState<Stage>({ name: 'entry' })
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [onlyConflicts, setOnlyConflicts] = useState(false)
  const [expanded, setExpanded] = useState<string>()
  const [working, setWorking] = useState<'scan' | 'apply'>()
  const [error, setError] = useState('')
  const [emptySource, setEmptySource] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const scanRef = useRef<HTMLButtonElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const focusNext = useRef(false)
  const running = useRef(false)

  function show(next: Stage) {
    focusNext.current = true
    setStage(next)
  }

  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    if (stage.name === 'entry') scanRef.current?.focus()
    else headingRef.current?.focus()
  }, [stage])

  const scan = stage.name === 'preview' || stage.name === 'confirm' ? stage.scan : undefined
  const items = scan?.items ?? []
  const rows = items.filter(({ category }) => category !== 'credential')
  const credentials = items.filter(({ category }) => category === 'credential')
  const selected = items.filter(({ id }) => selection.has(id))
  const ordinary = selected.filter(({ category }) => category !== 'credential')
  const selectedCredentials = selected.filter(({ category }) => category === 'credential')
  const additions = rows.filter(({ status }) => status === 'new')
  const selectedAdds = additions.filter(({ id }) => selection.has(id)).length
  const conflicts = rows.filter(({ status }) => status === 'conflict')
  const visibleRows = onlyConflicts ? conflicts : rows
  const lookup = new Map(rows.map((item) => [item.id, item]))

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedAdds > 0 && selectedAdds < additions.length
  }, [selectedAdds, additions.length, stage.name])

  function updateSelection(ids: string[], checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      for (const credential of credentials)
        if (credential.requires && lookup.get(credential.requires)?.status !== 'same' && !next.has(credential.requires))
          next.delete(credential.id)
      return next
    })
  }

  async function scanSource() {
    if (running.current) return
    running.current = true
    setWorking('scan')
    setError('')
    setEmptySource('')
    try {
      const next = await adapter.scan(hostId)
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
      setOnlyConflicts(false)
      setExpanded(next.items.find(({ status }) => status === 'conflict')?.id)
      show({ name: 'preview', scan: next })
    } catch (cause) {
      setError(migrationError(cause, '无法扫描 Pi 配置，请重试'))
    } finally {
      running.current = false
      setWorking(undefined)
    }
  }

  async function apply() {
    if (stage.name !== 'confirm' || running.current || !selected.length) return
    const { scan } = stage
    const request: PiMigrationApply = {
      revision: scan.revision,
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
      show({ name: 'result', source: scan.source, result })
    } catch (cause) {
      setError(migrationError(cause, '无法确认导入结果，请重新扫描'))
    } finally {
      running.current = false
      setWorking(undefined)
      onApplying(false)
    }
  }

  const errorMessage = error && (
    <p role="alert" className="wrap-anywhere text-destructive">
      {error}
    </p>
  )
  const entry = (
    <SettingsGroup title="导入与迁移">
      <SettingsCard>
        <SettingsRow>
          <div className="min-w-0 space-y-0.5">
            <h4 className="font-medium">从本地 Pi 迁移</h4>
            <p className={smallText}>导入 Pi CLI 的用户级配置。</p>
          </div>
          <Button
            ref={scanRef}
            type="button"
            size="sm"
            className={settingsControlClassName}
            disabled={Boolean(working)}
            onClick={() => void scanSource()}
          >
            <ScanSearch />
            {working === 'scan' ? '正在扫描…' : emptySource || error ? '重新扫描' : '扫描配置'}
          </Button>
        </SettingsRow>
        {(emptySource || error) && (
          <div className="px-4 py-3">
            {emptySource && (
              <p role="status" className={cn(smallText, 'wrap-anywhere')}>
                在 <code>{emptySource}</code> 未找到可迁移的 Pi 用户配置。
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
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="pi-migration-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pi-migration-title" className="text-lg font-semibold">
          从本地 Pi 迁移
        </h3>
        {stage.name === 'preview' && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={settingsControlClassName}
            onClick={() => {
              setError('')
              show({ name: 'entry' })
            }}
          >
            <ArrowLeft /> 返回常规
          </Button>
        )}
      </div>
      <dl className={cn(smallText, 'flex flex-wrap gap-x-6 gap-y-1 border-b border-border/70 pb-3')}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt>来源</dt>
          <dd className="min-w-0 font-mono wrap-anywhere select-text">{source}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt>导入到</dt>
          <dd>此电脑的 Pi meme</dd>
        </div>
      </dl>
      {stage.name === 'preview' && (
        <div className="space-y-3">
          <h4 tabIndex={-1} ref={headingRef} className="text-sm font-semibold outline-none">
            导入预览
          </h4>
          {rows.length > 0 && (
            <SettingsCard>
              <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/35 px-3 py-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    ref={selectAllRef}
                    className={checkboxClass}
                    checked={additions.length > 0 && selectedAdds === additions.length}
                    disabled={!additions.length || onlyConflicts}
                    onChange={(event) =>
                      updateSelection(
                        additions.map(({ id }) => id),
                        event.target.checked,
                      )
                    }
                  />
                  全选新增项
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={onlyConflicts}
                    onChange={(event) => setOnlyConflicts(event.target.checked)}
                  />
                  仅看冲突（{conflicts.length}）
                </label>
              </div>
              {visibleRows.length ? (
                <ul className="divide-y divide-border/40" aria-label="可迁移配置">
                  {visibleRows.map((item) => (
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
              ) : (
                <p className={cn(smallText, 'px-3 py-2')} role="status">
                  当前没有配置冲突。
                </p>
              )}
            </SettingsCard>
          )}
          {credentials.length > 0 && (
            <SettingsGroup
              title="凭据"
              action={<KeyRound aria-hidden="true" className="size-3.5 text-muted-foreground" />}
            >
              <SettingsCard>
                {credentials.map((item) => {
                  const requirement = item.requires ? lookup.get(item.requires) : undefined
                  const eligible =
                    item.status === 'new' &&
                    (!item.requires || requirement?.status === 'same' || selection.has(item.requires))
                  const hint =
                    !eligible && item.status === 'new'
                      ? `先选择 ${requirement?.name ?? '对应服务'} 的配置。`
                      : (item.note ?? '写入本机凭据存储，保留已有凭据。')
                  const hintId = `pi-migration-note-${encodeURIComponent(item.id)}`
                  return (
                    <SettingsRow key={item.id} className="justify-start gap-2 py-2.5">
                      <label className="flex min-w-0 items-center gap-2 wrap-anywhere">
                        <input
                          type="checkbox"
                          className={checkboxClass}
                          disabled={!eligible}
                          checked={selection.has(item.id)}
                          aria-describedby={hintId}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateSelection([item.id], event.target.checked)
                          }
                        />
                        {item.name}
                      </label>
                      <p id={hintId} className={cn(smallText, 'basis-full pl-6 wrap-anywhere')}>
                        {hint}
                      </p>
                    </SettingsRow>
                  )
                })}
              </SettingsCard>
            </SettingsGroup>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className={cn(smallText, 'tabular-nums')}>
              {selected.length ? `已选择 ${selected.length} 项` : '请选择要导入的配置'}
            </p>
            <Button
              type="button"
              className={settingsControlClassName}
              disabled={!selected.length}
              onClick={() => show({ name: 'confirm', scan: stage.scan })}
            >
              继续 <ArrowRight />
            </Button>
          </div>
        </div>
      )}
      {stage.name === 'confirm' && (
        <div className="space-y-3">
          <h4 tabIndex={-1} ref={headingRef} className="text-sm font-semibold outline-none">
            确认导入
          </h4>
          <SettingsCard>
            {(
              [
                ['新增', ordinary.filter(({ status }) => status === 'new')],
                ['覆盖', ordinary.filter(({ status }) => status === 'conflict')],
                ['凭据', selectedCredentials],
              ] as const
            ).map(
              ([label, group]) =>
                group.length > 0 && (
                  <SettingsRow key={label} className="justify-start gap-x-3 gap-y-1 py-2">
                    <span className="min-w-16 font-medium">
                      {label} {group.length} 项
                    </span>
                    <p className="min-w-0 flex-1 basis-48 wrap-anywhere">{group.map(({ name }) => name).join('、')}</p>
                  </SettingsRow>
                ),
            )}
          </SettingsCard>
          <p className={smallText}>覆盖前会备份现有配置。导入后可在此查看每项结果。</p>
          {errorMessage}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              className={settingsControlClassName}
              disabled={Boolean(working)}
              onClick={() => {
                setError('')
                show({ name: 'preview', scan: stage.scan })
              }}
            >
              <ArrowLeft /> 返回预览
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {error && (
                <Button
                  type="button"
                  variant="outline"
                  className={settingsControlClassName}
                  disabled={Boolean(working)}
                  onClick={() => void scanSource()}
                >
                  重新扫描
                </Button>
              )}
              <Button
                type="button"
                className={settingsControlClassName}
                disabled={Boolean(working) || !selected.length}
                onClick={() => void apply()}
              >
                {working === 'apply' ? '正在导入…' : `导入 ${selected.length} 项`}
              </Button>
            </div>
          </div>
        </div>
      )}
      {stage.name === 'result' && (
        <div className="space-y-3">
          <h4 tabIndex={-1} ref={headingRef} className="text-sm font-semibold outline-none">
            导入结果
          </h4>
          <ResultList result={stage.result} />
          {errorMessage}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              className={settingsControlClassName}
              disabled={Boolean(working)}
              onClick={() => void scanSource()}
            >
              {working === 'scan' ? '正在扫描…' : '重新扫描'}
            </Button>
            <Button
              type="button"
              className={settingsControlClassName}
              disabled={Boolean(working)}
              onClick={() => {
                setError('')
                show({ name: 'entry' })
              }}
            >
              完成
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
