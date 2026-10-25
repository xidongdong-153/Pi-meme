import { useEffect, useState } from 'react'
import type { BrowserOverlayPlatform, BrowserOverlayState } from '@pi-meme/contracts/browser'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Camera, Eye, EyeOff, Trash2, X } from 'lucide-react'

export function BrowserOverlay({ platform }: { platform: BrowserOverlayPlatform }) {
  const [state, setState] = useState<BrowserOverlayState>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const release = platform.onState(setState)
    void platform
      .state()
      .then(setState)
      .catch((cause) => setError(String(cause)))
    return release
  }, [platform])
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    for (const element of [document.documentElement, document.body, document.getElementById('root')]) {
      if (element) Object.assign(element.style, { height: '100%', width: '100%', minWidth: '0', overflow: 'hidden' })
    }
    document.documentElement.classList.toggle('dark', state?.theme !== 'light')
  }, [state?.theme])
  const action = async (value: Parameters<BrowserOverlayPlatform['action']>[0]) => {
    setPending(true)
    setError('')
    try {
      await platform.action(value)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setPending(false)
    }
  }
  if (!state) return <p role="status">{error || '正在加载批注…'}</p>
  if (state.kind === 'toolbar')
    return (
      <div className="flex h-full items-center justify-center bg-transparent p-1 text-foreground">
        <div className="flex items-center gap-0.5 rounded-xl border border-border bg-card p-1 shadow-xl">
          <span className="px-1 text-xs whitespace-nowrap">批注 · {state.count}</span>
          <Button
            size="icon-sm"
            className="size-6 shrink-0"
            variant="ghost"
            title="截取当前页面"
            onClick={() => void action({ type: 'screenshot' })}
          >
            <Camera className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            className="size-6 shrink-0"
            variant="ghost"
            title="隐藏标记"
            onClick={(event) => {
              const hidden = event.currentTarget.getAttribute('aria-pressed') !== 'true'
              event.currentTarget.setAttribute('aria-pressed', String(hidden))
              void action({ type: 'hide', hidden })
            }}
          >
            <EyeOff className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            className="size-6 shrink-0"
            variant="ghost"
            title="按住查看原始页面"
            onPointerDown={() => void action({ type: 'original', pressed: true })}
            onPointerUp={() => void action({ type: 'original', pressed: false })}
            onPointerLeave={() => void action({ type: 'original', pressed: false })}
          >
            <Eye className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            className="size-6 shrink-0"
            variant="ghost"
            title="丢弃批注"
            onClick={() => void action({ type: 'discard' })}
          >
            <Trash2 className="size-4" />
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={pending || !state.count}
            onClick={() => void action({ type: 'submit' })}
          >
            发送
          </Button>
          <Button
            size="icon-sm"
            className="size-6 shrink-0"
            variant="ghost"
            title="退出批注"
            onClick={() => void action({ type: 'exit' })}
          >
            <X className="size-4" />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    )
  return (
    <div className="m-1 flex flex-col gap-2 rounded-xl border border-border bg-card p-3 text-foreground shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">
          {state.annotation?.tag ?? '区域'} ·{' '}
          {state.annotation?.name || state.annotation?.text.slice(0, 60) || '网页批注'}
        </span>
        <Button
          size="icon-sm"
          className="size-6 shrink-0"
          variant="ghost"
          title="关闭批注输入"
          onClick={() => void action({ type: 'cancel' })}
        >
          <X className="size-3" />
        </Button>
      </div>
      <Textarea
        key={state.annotation?.id}
        defaultValue={state.annotation?.comment}
        autoFocus
        maxLength={16000}
        placeholder="添加评论…"
        className="h-20 min-h-20 resize-none"
        onChange={(event) =>
          void platform.action({ type: 'comment', text: event.target.value }).catch((cause) => setError(String(cause)))
        }
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void action({ type: 'add' })
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <select
          aria-label="批注截图"
          className="max-w-36 rounded bg-secondary px-2 py-1 text-xs"
          value={state.screenshot}
          onChange={(event) =>
            void action({ type: 'include', screenshot: event.target.value as BrowserOverlayState['screenshot'] })
          }
        >
          <option value="element">元素截图</option>
          <option value="viewport">当前视口</option>
          <option value="none">不附截图</option>
        </select>
        <Button size="sm" disabled={pending} onClick={() => void action({ type: 'add' })}>
          {pending ? '保存中…' : '加入对话'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
