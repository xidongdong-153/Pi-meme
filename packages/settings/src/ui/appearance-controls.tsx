import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import type { InstalledFont } from '@pi-meme/contracts/settings'
import { SettingsCard, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { ScrollArea } from '@pi-meme/ui/components/ui/scroll-area'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Slider } from '@pi-meme/ui/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { cn } from '@pi-meme/ui/lib/utils'
import { firstFontFamily } from './browser-fonts'

export function AppearanceRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <SettingsRow>
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        {description && <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>
    </SettingsRow>
  )
}
export function AppearanceGroup({ children }: { children: ReactNode }) {
  return <SettingsCard>{children}</SettingsCard>
}
export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
}) {
  return (
    <Select value={`choice:${value}`} onValueChange={(next) => onChange(next.slice('choice:'.length))}>
      <SelectTrigger aria-label={label} className={cn(settingsControlClassName, 'w-auto bg-secondary/60')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.value} value={`choice:${option.value}`} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export function ColorControl({
  label,
  value,
  onChange,
  onReset,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onReset: () => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  const valid = /^#[0-9a-f]{6}$/i.test(draft)
  function change(next: string) {
    setDraft(next)
    if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase())
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={`${label}颜色`} className={cn(settingsControlClassName, 'gap-2')}>
          <span className="size-4 rounded-full border border-border" style={{ background: value }} />
          {value.toUpperCase()}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="space-y-3" aria-label={`${label}颜色选择器`}>
        <Input
          type="color"
          aria-label={`${label}拾色器`}
          value={value}
          onChange={(event) => change(event.target.value)}
          className="h-12 w-full cursor-pointer"
        />
        <Input
          aria-label={`${label} HEX`}
          className={settingsControlClassName}
          value={draft}
          maxLength={7}
          aria-invalid={!valid}
          onChange={(event) => change(event.target.value)}
        />
        {!valid && (
          <p role="alert" className="text-xs text-destructive">
            请输入六位 HEX 颜色，例如 #181818
          </p>
        )}
        <Button className={settingsControlClassName} variant="outline" size="sm" onClick={onReset}>
          恢复主题默认
        </Button>
      </PopoverContent>
    </Popover>
  )
}
export function SizeControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  const valid = draft.trim() !== '' && Number.isInteger(Number(draft)) && Number(draft) >= min && Number(draft) <= max
  return (
    <div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          aria-label={label}
          className={cn(settingsControlClassName, 'w-20')}
          min={min}
          max={max}
          step={1}
          value={draft}
          aria-invalid={!valid}
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            const number = Number(next)
            if (next.trim() && Number.isInteger(number) && number >= min && number <= max) onChange(number)
          }}
        />
        <span className="text-xs text-muted-foreground">px</span>
      </div>
      {!valid && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          请输入 {min}–{max} 的整数
        </p>
      )}
    </div>
  )
}
export function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
  onReset,
  customized = false,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display: string
  onChange: (value: number) => void
  onReset: () => void
  customized?: boolean
}) {
  return (
    <div className="flex max-w-full items-center gap-2">
      <Slider
        aria-label={label}
        aria-valuetext={display}
        min={min}
        max={max}
        step={step}
        value={value}
        className="w-36 min-w-0 sm:w-48"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output
        aria-label={`${label}当前值`}
        className={cn(
          'min-w-12 shrink-0 whitespace-nowrap text-right text-xs font-medium tabular-nums transition-colors',
          customized ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {display}
      </output>
      <TooltipHint content={`恢复${label}默认值`}>
        <span className="inline-flex shrink-0" tabIndex={!customized ? 0 : undefined}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`恢复${label}默认值`}
            disabled={!customized}
            onClick={onReset}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </span>
      </TooltipHint>
    </div>
  )
}

export function FontControl({
  label,
  value,
  fonts,
  loading,
  error,
  load,
  hint,
  requestAccess,
  probe,
  onChange,
  inherit = false,
  code = false,
}: {
  label: string
  value?: string
  fonts: InstalledFont[]
  loading: boolean
  error: string
  load: () => void
  hint?: string
  requestAccess?: () => void
  probe?: (family: string) => InstalledFont | null
  onChange: (value?: string) => void
  inherit?: boolean
  code?: boolean
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const listbox = useRef<HTMLDivElement>(null)
  const system = code
    ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
    : '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  const selected = value && value !== 'inherit' ? probe?.(firstFontFamily(value)) : null
  const catalogue =
    selected && !fonts.some((font) => font.family.toLowerCase() === selected.family.toLowerCase())
      ? [...fonts, selected]
      : fonts
  const query = search.trim()
  const visible = catalogue.filter((font) => font.family.toLowerCase().includes(query.toLowerCase()))
  if (code) visible.sort((a, b) => Number(b.monospace) - Number(a.monospace))
  const exact = visible.find((font) => font.family.toLowerCase() === query.toLowerCase())
  const typed = Boolean(probe && query && !exact)
  const detected = typed ? probe?.(query) : null
  const stack = (family: string) => `${JSON.stringify(family)}, ${code ? 'monospace' : 'sans-serif'}`
  function choose(next?: string) {
    onChange(next)
    setOpen(false)
    setSearch('')
  }
  const text =
    !value || value === 'inherit'
      ? value === 'inherit'
        ? '与界面字体相同'
        : '跟随主题'
      : value === system
        ? '系统'
        : firstFontFamily(value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label} className={cn(settingsControlClassName, 'min-w-0 max-w-56 gap-2')}>
          <span className="truncate">{text}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="space-y-2" aria-label={`${label}选择器`}>
        <Input
          aria-label={`搜索${label}`}
          placeholder={probe ? '搜索或输入本机字体名称' : '搜索字体'}
          className="h-9 rounded-lg text-xs shadow-none"
          value={search}
          maxLength={200}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              listbox.current?.querySelector<HTMLButtonElement>('button[role="option"]:not(:disabled)')?.focus()
            }
            const entered = detected ?? exact
            if (event.key === 'Enter' && entered) {
              event.preventDefault()
              choose(stack(entered.family))
            }
          }}
        />
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            正在读取字体…
          </p>
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {!loading && !error && !fonts.length && !probe && (
          <p className="text-xs text-muted-foreground">未读取到系统字体，可使用跟随主题或系统默认。</p>
        )}
        {error && (
          <div>
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
            {!requestAccess && (
              <Button
                className={settingsControlClassName}
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={load}
              >
                重试
              </Button>
            )}
          </div>
        )}
        <ScrollArea className="h-60">
          <div
            ref={listbox}
            role="listbox"
            aria-label={label}
            aria-busy={loading}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)'),
              )
              if (!options.length) return
              event.preventDefault()
              const current = options.indexOf(document.activeElement as HTMLButtonElement)
              const index =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? options.length - 1
                    : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
              options[index]?.focus()
            }}
          >
            {[
              { family: '跟随主题', value: undefined },
              ...(inherit ? [{ family: '与界面字体相同', value: 'inherit' }] : []),
              { family: '系统', value: system },
              ...visible.map((font) => ({
                family: font.family,
                value: stack(font.family),
              })),
            ].map((font) => (
              <Button
                variant="ghost"
                role="option"
                aria-selected={font.value === value}
                key={font.family}
                className="h-auto min-h-8 w-full justify-between whitespace-normal rounded-lg px-2 py-1.5 text-left text-xs font-normal aria-selected:bg-secondary"
                onClick={() => choose(font.value)}
              >
                <span className="min-w-0 break-words">{font.family}</span>
                {font.value && font.value !== 'inherit' && font.value !== system && (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground"
                    style={{ fontFamily: font.value }}
                  >
                    Aa 字
                  </span>
                )}
              </Button>
            ))}
            {typed && (
              <Button
                role="option"
                aria-selected={false}
                variant="ghost"
                disabled={!detected}
                className="h-auto min-h-8 w-full justify-start whitespace-normal rounded-lg px-2 py-1.5 text-left text-xs font-normal"
                onClick={() => detected && choose(stack(detected.family))}
              >
                <span className="min-w-0 break-words">使用「{query}」</span>
              </Button>
            )}
            {!loading && query && !detected && !visible.length && (
              <p role="status" className="p-2 text-xs text-muted-foreground">
                {probe ? '当前浏览器未找到此字体' : '未找到匹配字体'}
              </p>
            )}
          </div>
        </ScrollArea>
        {requestAccess && (
          <Button
            variant="outline"
            size="sm"
            className={cn(settingsControlClassName, 'w-full')}
            disabled={loading}
            onClick={requestAccess}
          >
            读取全部本机字体
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
