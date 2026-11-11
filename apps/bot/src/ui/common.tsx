import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  ViewTransition,
} from 'react'
import type { FormEvent, ReactElement, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { createPortal } from 'react-dom'
import { Bot as BotIcon, Check as CheckIcon, LoaderCircle, X } from 'lucide-react'
import { agentAvatars, defaultUserAvatar } from '@pi-meme/assets/builtin'
import type { Snapshot } from '../shared/types'
import { Button, Input, Textarea } from './primitives'
import { motionTransition } from './motion'

export { Button, Input, Textarea }
export { Select } from './select'
export { CollapsibleSection } from '@pi-meme/ui/components/ui/collapsible'
export type PageProps = {
  snapshot: Snapshot
  refresh: () => Promise<void>
  navigate: (page: string, id?: string) => void
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId()
  const elements = Children.toArray(children)
  const first = elements[0]
  const isGroup = isValidElement(first) && (first.type === 'div' || first.type === 'details')
  const control = first as ReactElement<{ id?: string; 'aria-describedby'?: string }>
  const controlId = isValidElement(first) ? (control.props.id ?? id) : id
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className="field" role={isGroup ? 'group' : undefined} aria-labelledby={isGroup ? id : undefined}>
      {isGroup ? <span id={id}>{label}</span> : <label htmlFor={controlId}>{label}</label>}
      {!isGroup && isValidElement(first)
        ? cloneElement(control, {
            id: controlId,
            'aria-describedby': [control.props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined,
          })
        : first}
      {elements.slice(1)}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  )
}
export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}
export function Avatar({ name, avatar, user = false }: { name: string; avatar?: string; user?: boolean }) {
  return (
    <span className="avatar" aria-hidden="true">
      {!user && avatar ? (
        <span className="avatar-text">{avatar}</span>
      ) : (
        <img src={user ? defaultUserAvatar : agentAvatars[0]} alt={name} draggable={false} />
      )}
    </span>
  )
}
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <img src={agentAvatars[0]} alt="" draggable={false} />
    </span>
  )
}
export function DrawerClose() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="drawer-close"
      aria-label="关闭列表"
      onClick={() => window.dispatchEvent(new Event('bots:close-list'))}
    >
      <X size={17} />
    </Button>
  )
}
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <BotIcon size={28} strokeWidth={1.3} />
      <p>{children}</p>
      {action}
    </div>
  )
}
export function ErrorText({ error }: { error: unknown }) {
  return error ? (
    <p className="error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null
}
export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    queued: '等待中',
    running: '进行中',
    waiting: '等待确认',
    stopping: '正在停止',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    unknown: '结果待确认',
    blocked: '不可用',
    online: '已连接',
    offline: '已断开',
    unchecked: '尚未检查',
    disabled: '未启用',
    connecting: '连接中',
    pending: '等待投递',
    sending: '正在投递',
    sent: '已投递',
    'identity-changed': '身份变化',
  }
  return <span className={`status status-${value}`}>{labels[value] ?? value}</span>
}
export function Form({
  onSubmit,
  children,
  submit = '保存',
  onCancel,
}: {
  onSubmit: () => Promise<void>
  children: ReactNode
  submit?: string
  onCancel?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(setSaved, 1800, false)
    return () => clearTimeout(timer)
  }, [saved])
  async function handle(e: FormEvent) {
    e.preventDefault()
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setSaved(false)
    setError(undefined)
    try {
      await onSubmit()
      if (submit === '保存') setSaved(true)
    } catch (cause) {
      setError(cause)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(e) => void handle(e)} onChangeCapture={() => setSaved(false)} className="form" aria-busy={busy}>
      <fieldset disabled={busy}>{children}</fieldset>
      <ErrorText error={error} />
      <div className="form-actions">
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : saved ? <CheckIcon size={14} /> : null}
          {saved ? '已保存' : submit}
        </Button>
      </div>
    </form>
  )
}
const ModalDepthContext = createContext(0)

export function useModalDepth() {
  return useContext(ModalDepthContext)
}

export function Modal({
  title,
  children,
  onClose,
  className = '',
  placement = 'center',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
  placement?: 'center' | 'right'
}) {
  const depth = useContext(ModalDepthContext)
  const overlayZ = 80 + depth * 10
  const contentZ = 81 + depth * 10
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  function close() {
    motionTransition('bot-modal', onClose)
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(value) => {
        if (!value) close()
      }}
    >
      {createPortal(
        <ModalDepthContext.Provider value={depth + 1}>
          <ViewTransition default="none" enter="fade-in" exit="fade-out">
            <Dialog.Overlay className="bot-modal-overlay" style={{ zIndex: overlayZ }} />
          </ViewTransition>
          <ViewTransition
            default="none"
            enter={placement === 'right' ? 'drawer-from-right' : 'slide-up'}
            exit={placement === 'right' ? 'drawer-to-right' : 'slide-down'}
          >
            <Dialog.Content
              className={`bot-modal ${className}`}
              style={{ zIndex: contentZ }}
              data-bot-modal=""
              data-modal-depth={depth}
              aria-describedby={undefined}
              onEscapeKeyDown={(event) => {
                if (event.isComposing || event.keyCode === 229) event.preventDefault()
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true })
              }}
            >
              <div className="modal-heading">
                <Dialog.Title>{title}</Dialog.Title>
                <Button variant="ghost" size="icon-sm" onClick={close} aria-label={`关闭${title}`}>
                  <X size={17} />
                </Button>
              </div>
              {children}
            </Dialog.Content>
          </ViewTransition>
        </ModalDepthContext.Provider>,
        document.body,
      )}
    </Dialog.Root>
  )
}
export function useAction(refresh: () => Promise<void>) {
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState('')
  async function run(id: string, action: () => Promise<unknown>) {
    if (busy) return
    setBusy(id)
    setError(undefined)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy('')
    }
  }
  return { error, busy, run }
}
export function date(value?: string) {
  return value ? new Date(value).toLocaleString() : '—'
}
