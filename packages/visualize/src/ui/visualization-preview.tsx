import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { Slider } from '@pi-meme/ui/components/ui/slider'
import { Popover, PopoverTrigger, PopoverContent } from '@pi-meme/ui/components/ui/popover'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SlidersHorizontal, RotateCcw, PanelRightOpen } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  validateVisualizationState,
  type VisualizationDocument,
  type VisualizationState,
} from '@pi-meme/contracts/visualize'
import { previewDocument } from './preview-runtime'

const feedbackSubmissions = new Set<string>()

const themeKeys = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--muted',
  '--muted-foreground',
  '--primary',
  '--primary-foreground',
  '--border',
  '--accent',
  '--accent-foreground',
]
export function VisualizationPreview({
  document,
  storageKey,
  onOpen,
  onSubmit,
}: {
  document: VisualizationDocument
  storageKey: string
  onOpen?: () => void
  onSubmit: (text: string, state: VisualizationState) => Promise<boolean>
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const port = useRef<MessagePort | null>(null)
  const sequence = useRef(0)
  const [state, setState] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as VisualizationState
      validateVisualizationState(saved, document)
      return saved
    } catch {
      return document.initialState
    }
  })
  const current = useRef(state)
  const [height, setHeight] = useState(360)
  const [error, setError] = useState('')
  const [controls, setControls] = useState(false)
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(`${storageKey}:draft`) ?? ''
    } catch {
      return ''
    }
  })
  const changeDraft = (value: string) => {
    setDraft(value)
    try {
      localStorage.setItem(`${storageKey}:draft`, value)
    } catch {
      /* 保留内存草稿。 */
    }
    window.dispatchEvent(new CustomEvent('pi-visualization-draft', { detail: { key: storageKey, value } }))
  }
  useEffect(() => {
    const receive = (event: Event) => {
      const { detail } = event as CustomEvent<{ key: string; value: string }>
      if (detail.key === storageKey) setDraft(detail.value)
    }
    window.addEventListener('pi-visualization-draft', receive)
    return () => window.removeEventListener('pi-visualization-draft', receive)
  }, [storageKey])
  const [sending, setSending] = useState(false)
  const token = useMemo(() => crypto.randomUUID(), [])
  const source = useMemo(() => previewDocument(document, token), [document, token])
  const apply = (next: VisualizationState, broadcast = true) => {
    validateVisualizationState(next, document)
    current.current = next
    setState(next)
    port.current?.postMessage({ type: 'state', state: next, sequence: ++sequence.current })
    if (broadcast) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        /* 存储不可用时保留当前预览。 */
      }
      window.dispatchEvent(
        new CustomEvent('pi-visualization-state', { detail: { key: storageKey, state: next, token } }),
      )
    }
  }
  useEffect(() => {
    const receive = (event: Event) => {
      const { detail } = event as CustomEvent<{ key: string; state: VisualizationState; token: string }>
      if (detail.key === storageKey && detail.token !== token) apply(detail.state, false)
    }
    window.addEventListener('pi-visualization-state', receive)
    return () => {
      window.removeEventListener('pi-visualization-state', receive)
      port.current?.close()
    }
    // 状态通过 current 引用读取，监听仅随设计版本切换。
  }, [storageKey, token])
  const theme = () => {
    const computed = getComputedStyle(window.document.documentElement)
    return Object.fromEntries(themeKeys.map((key) => [key, computed.getPropertyValue(key)]))
  }
  useEffect(() => {
    const observer = new MutationObserver(() => port.current?.postMessage({ type: 'theme', values: theme() }))
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
  }, [])
  const initialize = () => {
    port.current?.close()
    const channel = new MessageChannel()
    port.current = channel.port1
    channel.port1.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return
      if (data.type === 'height' && Number.isFinite(data.height)) setHeight(Math.max(160, Math.min(1200, data.height)))
      if (data.type === 'error') setError(String(data.message).slice(0, 2000))
      if (data.type === 'patch') {
        try {
          if (!data.patch || typeof data.patch !== 'object' || Array.isArray(data.patch))
            throw new Error('状态变更无效')
          apply({ ...current.current, ...data.patch })
          channel.port1.postMessage({ type: 'reply', requestId: data.requestId, state: current.current })
        } catch (cause) {
          channel.port1.postMessage({ type: 'reply', requestId: data.requestId, error: String(cause) })
        }
      }
    }
    frame.current?.contentWindow?.postMessage(
      { token, state: current.current, sequence: sequence.current, theme: theme() },
      '*',
      [channel.port2],
    )
  }
  const feedbackForm = (
    <form
      className="flex gap-2"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!draft.trim() || sending || feedbackSubmissions.has(storageKey)) return
        feedbackSubmissions.add(storageKey)
        setSending(true)
        try {
          if (await onSubmit(draft, current.current)) {
            changeDraft('')
          }
        } catch (cause) {
          setError(String(cause))
        } finally {
          feedbackSubmissions.delete(storageKey)
          setSending(false)
        }
      }}
    >
      <Input
        aria-label="调整草图要求"
        placeholder="描述调整要求…"
        className="min-w-0 flex-1"
        value={draft}
        disabled={sending}
        onChange={(e) => changeDraft(e.target.value)}
      />
      <Button type="submit" disabled={sending || !draft.trim()}>
        {sending ? '发送中…' : '发送'}
      </Button>
    </form>
  )
  return (
    <Popover open={controls} onOpenChange={setControls}>
      <section className="min-w-0 space-y-3 rounded-xl border border-border/60 bg-card/30 p-3">
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate">
            {document.title} · 第 {document.revision} 版
          </span>
          {onOpen && (
            <Button size="icon" variant="ghost" aria-label="在右侧打开草图" onClick={onOpen}>
              <PanelRightOpen />
            </Button>
          )}
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="设计控件" aria-expanded={controls}>
              <SlidersHorizontal />
            </Button>
          </PopoverTrigger>
        </div>
        <iframe
          ref={frame}
          title={document.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          srcDoc={source}
          onLoad={initialize}
          className="w-full border-0"
          style={{ height }}
        />
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <PopoverContent side="top" align="end" className="w-[min(28rem,calc(100vw-2rem))] space-y-3">
          <div className="flex items-center justify-between">
            设计控件
            <Button variant="ghost" size="icon" aria-label="重置设计状态" onClick={() => apply(document.initialState)}>
              <RotateCcw />
            </Button>
          </div>
          {document.controls.map((control) => (
            <label key={control.key} className="flex items-center justify-between gap-3">
              <span>{control.label}</span>
              {control.type === 'select' ? (
                <Select
                  value={String(control.options.findIndex((option) => option.value === state[control.key]))}
                  onValueChange={(value) => apply({ ...state, [control.key]: control.options[Number(value)].value })}
                >
                  <SelectTrigger aria-label={control.label} className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {control.options.map((option, index) => (
                      <SelectItem key={option.value} value={String(index)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : control.type === 'toggle' ? (
                <Switch
                  label={control.label}
                  checked={Boolean(state[control.key])}
                  onChange={(checked) => apply({ ...state, [control.key]: checked })}
                />
              ) : control.type === 'slider' ? (
                <span className="flex items-center gap-2">
                  <Slider
                    aria-label={control.label}
                    min={control.min}
                    max={control.max}
                    step={control.step ?? 1}
                    value={Number(state[control.key])}
                    onChange={(e) => apply({ ...state, [control.key]: Number(e.target.value) })}
                  />
                  <span className="min-w-8 text-right text-sm tabular-nums">
                    {state[control.key]}
                    {control.unit}
                  </span>
                </span>
              ) : (
                <Input
                  type="color"
                  aria-label={control.label}
                  className="w-14 p-1"
                  value={String(state[control.key])}
                  onChange={(e) => apply({ ...state, [control.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          {onOpen && feedbackForm}
        </PopoverContent>
        {!onOpen && feedbackForm}
      </section>
    </Popover>
  )
}
