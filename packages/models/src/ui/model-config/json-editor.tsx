import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Minimize2,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'

export type JsonParseIssue = {
  message: string
  line?: number
  column?: number
}

const sensitiveHeaderPattern = /auth|key|token|secret|cookie/i

export function isSensitiveHeaderKey(key: string) {
  return sensitiveHeaderPattern.test(key)
}

function positionFromOffset(text: string, offset: number) {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const before = text.slice(0, clamped)
  const lines = before.split('\n')
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

export function analyzeJsonText(
  text: string,
  options?: {
    allowEmpty?: boolean
    requireObject?: boolean
    validate?: (value: unknown) => string | null
  },
): { valid: true; empty: boolean; value: unknown } | { valid: false; issue: JsonParseIssue } {
  const trimmed = text.trim()
  if (!trimmed) {
    if (options?.allowEmpty !== false) return { valid: true, empty: true, value: undefined }
    return { valid: false, issue: { message: 'JSON 不能为空' } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const lineColMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(raw)
    if (lineColMatch) {
      return {
        valid: false,
        issue: {
          message: raw,
          line: Number(lineColMatch[1]),
          column: Number(lineColMatch[2]),
        },
      }
    }
    const posMatch = /position\s+(\d+)/i.exec(raw)
    if (posMatch) {
      const pos = positionFromOffset(text, Number(posMatch[1]))
      return { valid: false, issue: { message: raw, ...pos } }
    }
    return { valid: false, issue: { message: raw } }
  }
  if (options?.requireObject && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    return { valid: false, issue: { message: '顶层必须是 JSON 对象（{ ... }）', line: 1, column: 1 } }
  }
  const customError = options?.validate?.(parsed)
  if (customError) return { valid: false, issue: { message: customError } }
  return { valid: true, empty: false, value: parsed }
}

export function JsonCodeEditor({
  id,
  ariaLabel,
  value,
  onChange,
  disabled,
  placeholder,
  allowEmpty = true,
  requireObject = true,
  validate,
  minHeightClass = 'min-h-36',
  maxHeightClass = 'max-h-72',
  showLineNumbers = true,
  showMinify = false,
  onReset,
  resetLabel = '还原',
  headerLeft,
  headerRight,
  footerHint,
}: {
  id?: string
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  placeholder?: string
  allowEmpty?: boolean
  requireObject?: boolean
  validate?: (value: unknown) => string | null
  minHeightClass?: string
  maxHeightClass?: string
  showLineNumbers?: boolean
  showMinify?: boolean
  onReset?: () => void
  resetLabel?: string
  headerLeft?: ReactNode
  headerRight?: ReactNode
  footerHint?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const [actionHint, setActionHint] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  const analysis = useMemo(
    () => analyzeJsonText(value, { allowEmpty, requireObject, validate }),
    [value, allowEmpty, requireObject, validate],
  )

  const lineCount = useMemo(() => Math.max(1, value.split('\n').length), [value])
  const errorLine = !analysis.valid ? analysis.issue.line : undefined

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(setCopied, 1500, false)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!actionHint) return
    const timer = setTimeout(setActionHint, 1800, '')
    return () => clearTimeout(timer)
  }, [actionHint])

  const formatJson = (spaces: number) => {
    if (!value.trim()) {
      setActionHint('内容为空')
      return
    }
    try {
      const parsed: unknown = JSON.parse(value)
      const formatted = spaces > 0 ? JSON.stringify(parsed, null, spaces) : JSON.stringify(parsed)
      onChange(formatted)
      setActionHint(spaces > 0 ? '已美化' : '已压缩')
    } catch {
      setActionHint('语法有误，无法格式化')
    }
  }

  const copyJson = async () => {
    if (!value.trim()) return
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
    } catch {
      setActionHint('复制失败')
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return
    const target = event.currentTarget
    const { selectionStart, selectionEnd } = target

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      formatJson(2)
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      if (!event.shiftKey) {
        const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
        onChange(next)
        requestAnimationFrame(() => {
          target.selectionStart = selectionStart + 2
          target.selectionEnd = selectionStart + 2
        })
      } else {
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
        const prefix = value.slice(lineStart, lineStart + 2)
        const removeCount = prefix === '  ' ? 2 : prefix.startsWith(' ') || prefix.startsWith('\t') ? 1 : 0
        if (removeCount > 0) {
          const next = value.slice(0, lineStart) + value.slice(lineStart + removeCount)
          onChange(next)
          requestAnimationFrame(() => {
            const nextPos = Math.max(lineStart, selectionStart - removeCount)
            target.selectionStart = nextPos
            target.selectionEnd = Math.max(lineStart, selectionEnd - removeCount)
          })
        }
      }
      return
    }

    if (event.key === 'Enter' && selectionStart === selectionEnd) {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
      const currentLine = value.slice(lineStart, selectionStart)
      const indentMatch = /^(\s*)/.exec(currentLine)
      const baseIndent = indentMatch ? indentMatch[1] : ''
      const opensBlock = /[{[]\s*$/.test(currentLine)
      const nextIndent = opensBlock ? `${baseIndent}  ` : baseIndent
      if (nextIndent) {
        event.preventDefault()
        const insertion = `\n${nextIndent}`
        const next = `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionEnd)}`
        onChange(next)
        requestAnimationFrame(() => {
          const pos = selectionStart + insertion.length
          target.selectionStart = pos
          target.selectionEnd = pos
        })
      }
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-background transition-colors',
        !analysis.valid ? 'border-destructive/50' : 'border-border/70 focus-within:border-ring/70',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border/60 bg-secondary/35 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {headerLeft}
          {!analysis.valid ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/12 px-2 py-0.5 text-[10px] font-medium text-destructive">
              <AlertCircle aria-hidden="true" className="size-3 shrink-0" />
              {analysis.issue.line ? `第 ${analysis.issue.line} 行有误` : '格式错误'}
            </span>
          ) : !analysis.empty ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 aria-hidden="true" className="size-3 shrink-0" />
              有效
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">未配置</span>
          )}
          {actionHint && <span className="text-[10px] text-muted-foreground">{actionHint}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <TooltipHint content="美化格式（⌘/Ctrl + Shift + F）">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 gap-1 rounded-md px-1.5 text-[11px]"
              disabled={disabled || !value.trim()}
              onClick={() => formatJson(2)}
            >
              <Sparkles className="size-3" />
              美化
            </Button>
          </TooltipHint>
          {showMinify && (
            <TooltipHint content="压缩为单行">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="压缩 JSON"
                className="size-6 rounded-md text-muted-foreground hover:text-foreground"
                disabled={disabled || !value.trim()}
                onClick={() => formatJson(0)}
              >
                <Minimize2 className="size-3" />
              </Button>
            </TooltipHint>
          )}
          <TooltipHint content={copied ? '已复制' : '复制 JSON'}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="复制 JSON"
              className="size-6 rounded-md text-muted-foreground hover:text-foreground"
              disabled={!value.trim()}
              onClick={() => void copyJson()}
            >
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </Button>
          </TooltipHint>
          {onReset && (
            <TooltipHint content={resetLabel}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={resetLabel}
                className="size-6 rounded-md text-muted-foreground hover:text-foreground"
                disabled={disabled}
                onClick={onReset}
              >
                <RotateCcw className="size-3" />
              </Button>
            </TooltipHint>
          )}
          {headerRight}
        </div>
      </div>

      <div className={cn('relative flex min-w-0 font-mono text-[11px] leading-[1.6]', minHeightClass, maxHeightClass)}>
        {showLineNumbers && (
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="w-9 shrink-0 overflow-hidden border-r border-border/50 bg-secondary/20 py-2.5 pr-2 text-right text-[10px] leading-[1.6] text-muted-foreground/70 tabular-nums select-none"
          >
            {Array.from({ length: lineCount }, (_, index) => {
              const lineNumber = index + 1
              const isErrorLine = errorLine === lineNumber
              return (
                <div key={lineNumber} className={cn(isErrorLine && 'font-semibold text-destructive')}>
                  {lineNumber}
                </div>
              )
            })}
          </div>
        )}
        <textarea
          ref={textareaRef}
          id={id}
          aria-label={ariaLabel}
          aria-invalid={!analysis.valid}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
          }}
          className={cn(
            'min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 select-text',
            minHeightClass,
            maxHeightClass,
          )}
        />
      </div>

      {!analysis.valid && (
        <div
          role="alert"
          className="flex items-start gap-1.5 border-t border-destructive/25 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <p className="min-w-0 break-words">
            {analysis.issue.line && analysis.issue.column
              ? `第 ${analysis.issue.line} 行第 ${analysis.issue.column} 列：`
              : ''}
            {analysis.issue.message}
          </p>
        </div>
      )}

      {footerHint && (
        <div className="border-t border-border/50 bg-secondary/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {footerHint}
        </div>
      )}
    </div>
  )
}

type HeaderRow = { id: number; key: string; value: string }

function parseHeadersToRows(
  text: string,
  nextId: () => number,
): { ok: true; rows: HeaderRow[] } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, rows: [] }
  const analysis = analyzeJsonText(text, { allowEmpty: true, requireObject: true })
  if (!analysis.valid) return { ok: false, error: analysis.issue.message }
  const record = analysis.value as Record<string, unknown>
  const rows: HeaderRow[] = []
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== 'string') return { ok: false, error: `请求头 "${key}" 的值必须是字符串` }
    rows.push({ id: nextId(), key, value: val })
  }
  return { ok: true, rows }
}

function serializeHeaderRows(rows: HeaderRow[]) {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    record[key] = row.value
  }
  return Object.keys(record).length ? JSON.stringify(record, null, 2) : ''
}

export function HeadersJsonField({
  label,
  ariaLabel,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  compact?: boolean
}) {
  const idCounter = useRef(0)
  const nextId = () => ++idCounter.current

  const initialParsed = parseHeadersToRows(value, nextId)
  const [mode, setMode] = useState<'form' | 'json'>(initialParsed.ok ? 'form' : 'json')
  const [rows, setRows] = useState<HeaderRow[]>(() => (initialParsed.ok ? initialParsed.rows : []))
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const [switchError, setSwitchError] = useState('')
  const lastSerializedRef = useRef(value)

  useEffect(() => {
    if (value === lastSerializedRef.current) return
    lastSerializedRef.current = value
    const parsed = parseHeadersToRows(value, nextId)
    if (parsed.ok) {
      setRows(parsed.rows)
      setSwitchError('')
    } else {
      setMode('json')
    }
  }, [value])

  const updateRows = (nextRows: HeaderRow[]) => {
    setRows(nextRows)
    const serialized = serializeHeaderRows(nextRows)
    lastSerializedRef.current = serialized
    onChange(serialized)
  }

  const handleModeChange = (nextMode: 'form' | 'json') => {
    if (nextMode === mode) return
    if (nextMode === 'form') {
      const parsed = parseHeadersToRows(value, nextId)
      if (!parsed.ok) {
        setSwitchError(`无法切回表单：${parsed.error}`)
        return
      }
      setRows(parsed.rows)
      setSwitchError('')
      setMode('form')
    } else {
      const serialized = serializeHeaderRows(rows)
      lastSerializedRef.current = serialized
      onChange(serialized)
      setSwitchError('')
      setMode('json')
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium leading-snug text-foreground">{label}</span>
        <div
          role="group"
          aria-label={`${label}编辑模式`}
          className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-secondary/50 p-0.5"
        >
          <button
            type="button"
            aria-pressed={mode === 'form'}
            disabled={disabled}
            onClick={() => handleModeChange('form')}
            className={cn(
              'inline-flex h-5 cursor-pointer items-center gap-1 rounded px-2 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
              mode === 'form'
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <SlidersHorizontal aria-hidden="true" className="size-2.5" />
            表单
          </button>
          <button
            type="button"
            aria-pressed={mode === 'json'}
            disabled={disabled}
            onClick={() => handleModeChange('json')}
            className={cn(
              'inline-flex h-5 cursor-pointer items-center gap-1 rounded px-2 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
              mode === 'json'
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Code2 aria-hidden="true" className="size-2.5" />
            JSON
          </button>
        </div>
      </div>

      {mode === 'form' ? (
        <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/50 p-2">
          {rows.length > 0 ? (
            <div className="space-y-1.5">
              {rows.map((row) => {
                const isSensitive = isSensitiveHeaderKey(row.key)
                const visible = !isSensitive || !!revealed[row.id]
                return (
                  <div key={row.id} className="flex items-center gap-1.5">
                    <Input
                      aria-label={`${ariaLabel} 键`}
                      placeholder="Header 名称"
                      autoComplete="off"
                      disabled={disabled}
                      value={row.key}
                      onChange={(event) =>
                        updateRows(
                          rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)),
                        )
                      }
                      className={cn(
                        settingsControlClassName,
                        'h-7 w-[40%] shrink-0 bg-background font-mono text-[11px]',
                      )}
                    />
                    <div className="relative min-w-0 flex-1">
                      <Input
                        aria-label={`${ariaLabel} 值`}
                        placeholder={isSensitive ? '留空保留已存凭据' : 'Header 值'}
                        autoComplete="off"
                        type={visible ? 'text' : 'password'}
                        disabled={disabled}
                        value={row.value}
                        onChange={(event) =>
                          updateRows(
                            rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)),
                          )
                        }
                        className={cn(
                          settingsControlClassName,
                          'h-7 w-full bg-background font-mono text-[11px]',
                          isSensitive && 'pr-7',
                        )}
                      />
                      {isSensitive && (
                        <TooltipHint content={visible ? '隐藏值' : '显示值'}>
                          <button
                            type="button"
                            aria-label={visible ? '隐藏值' : '显示值'}
                            disabled={disabled}
                            onClick={() => setRevealed((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                          </button>
                        </TooltipHint>
                      )}
                    </div>
                    <TooltipHint content="移除请求头">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="移除请求头"
                        disabled={disabled}
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => updateRows(rows.filter((item) => item.id !== row.id))}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </TooltipHint>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="px-1 py-1 text-[11px] text-muted-foreground">暂无自定义请求头</p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => updateRows([...rows, { id: nextId(), key: '', value: '' }])}
          >
            <Plus className="size-3" />
            添加请求头
          </Button>
        </div>
      ) : (
        <JsonCodeEditor
          ariaLabel={ariaLabel}
          value={value}
          onChange={(next) => {
            lastSerializedRef.current = next
            setSwitchError('')
            onChange(next)
          }}
          disabled={disabled}
          placeholder={'{\n  "X-Custom-Header": "value"\n}'}
          minHeightClass={compact ? 'min-h-24' : 'min-h-28'}
          maxHeightClass={compact ? 'max-h-44' : 'max-h-56'}
          showLineNumbers={!compact}
          validate={(parsed) => {
            const obj = parsed as Record<string, unknown>
            for (const [k, v] of Object.entries(obj)) {
              if (!k.trim() || typeof v !== 'string') return `请求头 "${k}" 的值必须是字符串`
            }
            return null
          }}
        />
      )}

      {switchError && (
        <p role="alert" className="text-[11px] text-destructive">
          {switchError}
        </p>
      )}
    </div>
  )
}

type CompatValueType = 'boolean' | 'string' | 'number' | 'json'
type CompatRow = {
  id: number
  key: string
  type: CompatValueType
  boolValue: boolean
  textValue: string
}

const commonCompatPresets: { key: string; type: CompatValueType; boolValue?: boolean; textValue?: string }[] = [
  { key: 'supportsDeveloperRole', type: 'boolean', boolValue: false },
  { key: 'supportsStore', type: 'boolean', boolValue: false },
  { key: 'supportsReasoningEffort', type: 'boolean', boolValue: true },
  { key: 'maxTokensField', type: 'string', textValue: 'max_completion_tokens' },
]

function inferCompatRow(key: string, val: unknown, id: number): CompatRow {
  if (typeof val === 'boolean') return { id, key, type: 'boolean', boolValue: val, textValue: String(val) }
  if (typeof val === 'number') return { id, key, type: 'number', boolValue: false, textValue: String(val) }
  if (typeof val === 'string') return { id, key, type: 'string', boolValue: false, textValue: val }
  return { id, key, type: 'json', boolValue: false, textValue: JSON.stringify(val) }
}

function parseCompatToRows(
  text: string,
  nextId: () => number,
): { ok: true; rows: CompatRow[] } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, rows: [] }
  const analysis = analyzeJsonText(text, { allowEmpty: true, requireObject: true })
  if (!analysis.valid) return { ok: false, error: analysis.issue.message }
  const record = analysis.value as Record<string, unknown>
  return {
    ok: true,
    rows: Object.entries(record).map(([key, val]) => inferCompatRow(key, val, nextId())),
  }
}

function serializeCompatRows(rows: CompatRow[]): string {
  const record: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    if (row.type === 'boolean') record[key] = row.boolValue
    else if (row.type === 'number') {
      const num = Number(row.textValue)
      record[key] = Number.isFinite(num) && row.textValue.trim() !== '' ? num : 0
    } else if (row.type === 'json') {
      try {
        record[key] = JSON.parse(row.textValue)
      } catch {
        record[key] = row.textValue
      }
    } else {
      record[key] = row.textValue
    }
  }
  return Object.keys(record).length ? JSON.stringify(record, null, 2) : ''
}

function validateCompatObject(parsed: unknown): string | null {
  const compat = parsed as Record<string, unknown>
  for (const [key, entry] of Object.entries(compat)) {
    if (
      /^(?:supports|requires|sendSession|forceAdaptive|allowEmptySignature)/.test(key) &&
      typeof entry !== 'boolean'
    ) {
      return `compat.${key} 必须是布尔值`
    }
  }
  if (
    compat.maxTokensField !== undefined &&
    !['max_tokens', 'max_completion_tokens'].includes(String(compat.maxTokensField))
  ) {
    return 'compat.maxTokensField 必须是 max_tokens 或 max_completion_tokens'
  }
  return null
}

export function CompatJsonField({
  label,
  ariaLabel,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  compact?: boolean
}) {
  const idCounter = useRef(0)
  const nextId = () => ++idCounter.current

  const initialParsed = parseCompatToRows(value, nextId)
  const [mode, setMode] = useState<'form' | 'json'>(initialParsed.ok ? 'form' : 'json')
  const [rows, setRows] = useState<CompatRow[]>(() => (initialParsed.ok ? initialParsed.rows : []))
  const [switchError, setSwitchError] = useState('')
  const lastSerializedRef = useRef(value)

  useEffect(() => {
    if (value === lastSerializedRef.current) return
    lastSerializedRef.current = value
    const parsed = parseCompatToRows(value, nextId)
    if (parsed.ok) {
      setRows(parsed.rows)
      setSwitchError('')
    } else {
      setMode('json')
    }
  }, [value])

  const updateRows = (nextRows: CompatRow[]) => {
    setRows(nextRows)
    const serialized = serializeCompatRows(nextRows)
    lastSerializedRef.current = serialized
    onChange(serialized)
  }

  const handleModeChange = (nextMode: 'form' | 'json') => {
    if (nextMode === mode) return
    if (nextMode === 'form') {
      const parsed = parseCompatToRows(value, nextId)
      if (!parsed.ok) {
        setSwitchError(`无法切回表单：${parsed.error}`)
        return
      }
      setRows(parsed.rows)
      setSwitchError('')
      setMode('form')
    } else {
      const serialized = serializeCompatRows(rows)
      lastSerializedRef.current = serialized
      onChange(serialized)
      setSwitchError('')
      setMode('json')
    }
  }

  const existingKeys = new Set(rows.map((row) => row.key.trim()))
  const availablePresets = commonCompatPresets.filter((preset) => !existingKeys.has(preset.key))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium leading-snug text-foreground">{label}</span>
        <div
          role="group"
          aria-label={`${label}编辑模式`}
          className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-secondary/50 p-0.5"
        >
          <button
            type="button"
            aria-pressed={mode === 'form'}
            disabled={disabled}
            onClick={() => handleModeChange('form')}
            className={cn(
              'inline-flex h-5 cursor-pointer items-center gap-1 rounded px-2 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
              mode === 'form'
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <SlidersHorizontal aria-hidden="true" className="size-2.5" />
            表单
          </button>
          <button
            type="button"
            aria-pressed={mode === 'json'}
            disabled={disabled}
            onClick={() => handleModeChange('json')}
            className={cn(
              'inline-flex h-5 cursor-pointer items-center gap-1 rounded px-2 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
              mode === 'json'
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Code2 aria-hidden="true" className="size-2.5" />
            JSON
          </button>
        </div>
      </div>

      {mode === 'form' ? (
        <div className="space-y-2 rounded-lg border border-border/60 bg-background/50 p-2">
          {rows.length > 0 ? (
            <div className="space-y-1.5">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center gap-1.5">
                  <Input
                    aria-label={`${ariaLabel} 键`}
                    placeholder="参数名"
                    autoComplete="off"
                    disabled={disabled}
                    value={row.key}
                    onChange={(event) =>
                      updateRows(rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)))
                    }
                    className={cn(settingsControlClassName, 'h-7 min-w-0 flex-1 bg-background font-mono text-[11px]')}
                  />
                  <Select
                    value={row.type}
                    disabled={disabled}
                    onValueChange={(nextType: CompatValueType) =>
                      updateRows(
                        rows.map((item) =>
                          item.id === row.id
                            ? {
                                ...item,
                                type: nextType,
                                boolValue: nextType === 'boolean' ? item.boolValue : false,
                                textValue:
                                  nextType === 'number' && !Number.isFinite(Number(item.textValue))
                                    ? '0'
                                    : item.textValue,
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={`${ariaLabel} 类型`}
                      className="h-7 w-18 shrink-0 rounded-lg bg-background px-2 text-[10px] shadow-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="boolean" className="text-xs">
                        布尔
                      </SelectItem>
                      <SelectItem value="string" className="text-xs">
                        文本
                      </SelectItem>
                      <SelectItem value="number" className="text-xs">
                        数字
                      </SelectItem>
                      <SelectItem value="json" className="text-xs">
                        JSON
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {row.type === 'boolean' ? (
                    <div className="flex h-7 w-28 shrink-0 items-center justify-between rounded-lg border border-border/60 bg-background px-2">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {row.boolValue ? 'true' : 'false'}
                      </span>
                      <span className="inline-flex origin-right scale-75">
                        <Switch
                          label={`${row.key || ariaLabel} 布尔值`}
                          checked={row.boolValue}
                          disabled={disabled}
                          onChange={(checked) =>
                            updateRows(
                              rows.map((item) => (item.id === row.id ? { ...item, boolValue: checked } : item)),
                            )
                          }
                        />
                      </span>
                    </div>
                  ) : row.key === 'maxTokensField' && row.type === 'string' ? (
                    <Select
                      value={row.textValue || 'max_completion_tokens'}
                      disabled={disabled}
                      onValueChange={(nextVal) =>
                        updateRows(rows.map((item) => (item.id === row.id ? { ...item, textValue: nextVal } : item)))
                      }
                    >
                      <SelectTrigger
                        aria-label="maxTokensField 值"
                        className="h-7 w-36 shrink-0 rounded-lg bg-background px-2 font-mono text-[10px] shadow-none"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="max_tokens" className="font-mono text-xs">
                          max_tokens
                        </SelectItem>
                        <SelectItem value="max_completion_tokens" className="font-mono text-xs">
                          max_completion_tokens
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label={`${ariaLabel} 值`}
                      type={row.type === 'number' ? 'number' : 'text'}
                      placeholder={row.type === 'json' ? '{"key":true}' : '参数值'}
                      autoComplete="off"
                      disabled={disabled}
                      value={row.textValue}
                      onChange={(event) =>
                        updateRows(
                          rows.map((item) => (item.id === row.id ? { ...item, textValue: event.target.value } : item)),
                        )
                      }
                      className={cn(settingsControlClassName, 'h-7 w-28 shrink-0 bg-background font-mono text-[11px]')}
                    />
                  )}
                  <TooltipHint content="移除参数">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="移除 compat 参数"
                      disabled={disabled}
                      className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => updateRows(rows.filter((item) => item.id !== row.id))}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </TooltipHint>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 py-0.5 text-[11px] text-muted-foreground">暂无兼容参数</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() =>
                updateRows([...rows, { id: nextId(), key: '', type: 'boolean', boolValue: false, textValue: '' }])
              }
            >
              <Plus className="size-3" />
              添加参数
            </Button>
            {!compact &&
              availablePresets.slice(0, 3).map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    updateRows([
                      ...rows,
                      {
                        id: nextId(),
                        key: preset.key,
                        type: preset.type,
                        boolValue: preset.boolValue ?? false,
                        textValue: preset.textValue ?? '',
                      },
                    ])
                  }
                  className="inline-flex h-5 cursor-pointer items-center rounded border border-border/60 bg-background/70 px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                >
                  + {preset.key}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <JsonCodeEditor
          ariaLabel={ariaLabel}
          value={value}
          onChange={(next) => {
            lastSerializedRef.current = next
            setSwitchError('')
            onChange(next)
          }}
          disabled={disabled}
          placeholder={'{\n  "supportsDeveloperRole": false\n}'}
          minHeightClass={compact ? 'min-h-24' : 'min-h-28'}
          maxHeightClass={compact ? 'max-h-44' : 'max-h-56'}
          showLineNumbers={!compact}
          validate={validateCompatObject}
        />
      )}

      {switchError && (
        <p role="alert" className="text-[11px] text-destructive">
          {switchError}
        </p>
      )}
    </div>
  )
}
