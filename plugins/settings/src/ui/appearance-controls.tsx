import { useEffect, useState, type ReactNode } from 'react'
import type { InstalledFont } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'

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
  return <div className="rounded-2xl border border-border bg-card p-5 divide-y divide-border">{children}</div>
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
    <select
      aria-label={label}
      className="max-w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`h-6 w-11 shrink-0 rounded-full p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${value ? 'bg-primary' : 'bg-secondary'}`}
    >
      <span className={`block size-5 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : ''}`} />
    </button>
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
      <PopoverContent className="space-y-3" aria-label={`${label}颜色选择器`}>
        <input
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
function monospace(family: string) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return false
  context.font = `16px ${JSON.stringify(family)}, monospace`
  return Math.abs(context.measureText('iiiiiiii').width - context.measureText('WWWWWWWW').width) < 0.1
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
  const [mono, setMono] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (code && open) setMono(new Set(fonts.filter((font) => monospace(font.family)).map((font) => font.family)))
  }, [fonts, code, open])
  const system = code
    ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
    : '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  const visible = fonts.filter((font) => font.family.toLowerCase().includes(search.toLowerCase()))
  if (code) visible.sort((a, b) => Number(mono.has(b.family)) - Number(mono.has(a.family)))
  const text =
    !value || value === 'inherit'
      ? inherit
        ? '与界面字体相同'
        : '跟随主题'
      : value === system
        ? '系统'
        : value.split(',')[0].replaceAll('"', '')
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) load()
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label} className="h-8 max-w-56 rounded-full text-sm">
          <span className="truncate">{text}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-2" aria-label={`${label}选择器`}>
        <Input
          aria-label={`搜索${label}`}
          placeholder="搜索本机字体"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            正在读取本机字体…
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
        <div role="listbox" aria-label={label} className="max-h-60 overflow-y-auto">
          {[
            { family: inherit ? '与界面字体相同' : '跟随主题', value: undefined },
            { family: '系统', value: system },
            ...visible.map((font) => ({
              family: font.family,
              value: `${JSON.stringify(font.family)}, ${code ? 'monospace' : 'sans-serif'}`,
            })),
          ].map((font) => (
            <button
              type="button"
              role="option"
              aria-selected={font.value === value}
              key={font.family}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-secondary focus-visible:bg-secondary"
              onClick={() => {
                onChange(font.value)
                setOpen(false)
              }}
            >
              {font.family}
            </button>
          ))}
          {!loading && !error && !visible.length && search && (
            <p className="p-2 text-xs text-muted-foreground">未找到匹配字体</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
