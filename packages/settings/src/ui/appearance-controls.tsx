import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import type { InstalledFont } from '@pi-meme/contracts/settings'
import { Card } from '@pi-meme/ui/components/ui/card'
import { ScrollArea } from '@pi-meme/ui/components/ui/scroll-area'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Slider } from '@pi-meme/ui/components/ui/slider'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

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
    <div className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}
export function AppearanceGroup({ children }: { children: ReactNode }) {
  return <Card className="rounded-2xl p-5 divide-y divide-border">{children}</Card>
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
      <SelectTrigger aria-label={label} className="h-8 w-auto max-w-full rounded-full bg-background text-sm">
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
        <Button variant="outline" aria-label={`${label}颜色`} className="rounded-full h-8 text-sm gap-2">
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
        <Button variant="outline" size="sm" onClick={onReset}>
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
          className="w-20 h-8"
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
        className="w-32 min-w-0 sm:w-40"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output aria-label={`${label}当前值`} className="w-14 shrink-0 text-right text-sm tabular-nums">
        {display}
      </output>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`恢复${label}默认值`}
        title={`恢复${label}默认值`}
        disabled={!customized}
        onClick={onReset}
      >
        <RotateCcw className="size-3.5" />
      </Button>
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
  onChange: (value?: string) => void
  inherit?: boolean
  code?: boolean
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const system = code
    ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
    : '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  const visible = fonts.filter((font) => font.family.toLowerCase().includes(search.toLowerCase()))
  if (code) visible.sort((a, b) => Number(b.monospace) - Number(a.monospace))
  const text =
    !value || value === 'inherit'
      ? value === 'inherit'
        ? '与界面字体相同'
        : '跟随主题'
      : value === system
        ? '系统'
        : value.split(',')[0].replaceAll('"', '')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label} className="h-8 max-w-56 gap-3 rounded-full text-sm">
          <span className="truncate">{text}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="space-y-2" aria-label={`${label}选择器`}>
        <Input
          aria-label={`搜索${label}`}
          placeholder="搜索字体"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            正在读取字体…
          </p>
        )}
        {!loading && !error && !fonts.length && (
          <p className="text-xs text-muted-foreground">
            无法枚举浏览器系统字体，可使用跟随主题、系统默认或已保存的主题字体。
          </p>
        )}
        {error && (
          <div>
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
            <Button size="sm" variant="outline" onClick={load}>
              重试
            </Button>
          </div>
        )}
        <ScrollArea className="h-60">
          <div role="listbox" aria-label={label}>
            {[
              { family: '跟随主题', value: undefined },
              ...(inherit ? [{ family: '与界面字体相同', value: 'inherit' }] : []),
              { family: '系统', value: system },
              ...visible.map((font) => ({
                family: font.family,
                value: `${JSON.stringify(font.family)}, ${code ? 'monospace' : 'sans-serif'}`,
              })),
            ].map((font) => (
              <Button
                variant="ghost"
                role="option"
                aria-selected={font.value === value}
                key={font.family}
                className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal aria-selected:bg-secondary"
                onClick={() => {
                  onChange(font.value)
                  setOpen(false)
                }}
              >
                {font.family}
              </Button>
            ))}
            {!loading && !error && !visible.length && search && (
              <p className="p-2 text-xs text-muted-foreground">未找到匹配字体</p>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
