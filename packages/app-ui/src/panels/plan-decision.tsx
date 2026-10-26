import { useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ArrowUp, Pencil, X } from 'lucide-react'
import type { PlanAction, PlanDocument } from '@pi-meme/contracts/plan'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { ErrorLine } from '@pi-meme/ui/components/error-line'

export function PlanDecision({
  document,
  hostId,
  visible,
  readOnly,
  model,
  access,
  children,
  onSubmit,
  onSkip,
  draft,
  onDraftChange,
}: {
  document: PlanDocument
  hostId: string
  visible: boolean
  readOnly: boolean
  model: ReactNode
  access: ReactNode
  children: ReactNode
  onSubmit: (action: PlanAction, text?: string) => Promise<boolean>
  onSkip: (text: string) => void
  draft?: string
  onDraftChange?: (text: string) => void
}) {
  const storageKey = `pi-meme:plan-decision:${hostId}:${document.sessionId}:${document.id}`
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === String(document.revision)
    } catch {
      return false
    }
  })
  const [localText, setLocalText] = useState('')
  const text = draft ?? localText
  const setText = onDraftChange ?? setLocalText
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  function dismiss() {
    try {
      localStorage.setItem(storageKey, String(document.revision))
    } catch {
      /* 存储不可用时保留当前窗口状态。 */
    }
    setDismissed(true)
  }
  function skip() {
    if (pending.current) return
    dismiss()
    onSkip(text)
    setText('')
  }
  async function submit(intent: PlanAction['intent']) {
    if (pending.current || (intent === 'execute' && readOnly)) return
    pending.current = true
    setSubmitting(true)
    setError('')
    try {
      if (
        await onSubmit(
          { intent, reference: { id: document.id, revision: document.revision } },
          intent === 'revise' ? text : undefined,
        )
      ) {
        dismiss()
        if (intent === 'revise') setText('')
      }
    } catch (cause) {
      setError(String(cause))
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }
  if (dismissed || !visible) return children
  return (
    <div className="@container space-y-1">
      <section
        aria-label="实施此计划"
        className="rounded-[20px] border border-border/70 p-2"
        style={{ backgroundColor: 'color-mix(in srgb, var(--background), var(--foreground) 9%)' }}
      >
        <header className="mb-2 flex min-h-7 items-center justify-between pl-2 pr-0.5">
          <h3 className="text-sm font-medium">实施此计划？</h3>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            aria-label="关闭并跳过计划选择"
            disabled={submitting}
            onClick={skip}
          >
            <X className="size-4" />
          </Button>
        </header>
        <button
          type="button"
          disabled={submitting || readOnly || Boolean(text.trim())}
          onClick={() => void submit('execute')}
          className="flex min-h-8 w-full items-center gap-2.5 rounded-xl bg-foreground/5 px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-foreground/5"
        >
          <span
            aria-hidden="true"
            className="size-5 shrink-0 rounded-md border border-foreground/15 bg-foreground/[0.025]"
          />
          是，实施此计划
          <ArrowRight className="ml-auto size-4 text-muted-foreground" />
        </button>
        <form
          className="mt-2 flex items-start gap-2.5 px-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim()) void submit('revise')
          }}
        >
          <Pencil aria-hidden="true" className="mt-2.5 size-4 shrink-0 text-muted-foreground/70" />
          <Textarea
            aria-label="计划调整要求"
            placeholder="输入调整要求……"
            value={text}
            disabled={submitting}
            rows={1}
            className="field-sizing-content min-h-9 max-h-40 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-1.5 text-sm leading-6 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault()
                if (text.trim()) void submit('revise')
              }
            }}
          />
          {text.trim() ? (
            <Button
              type="submit"
              size="icon"
              className="mb-1 size-7 shrink-0 self-end rounded-full"
              disabled={submitting}
              aria-label="发送计划调整要求"
            >
              <ArrowUp className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mb-1 h-7 shrink-0 self-end rounded-full border-foreground/10 px-2.5 text-sm font-normal shadow-none hover:bg-foreground/5"
              disabled={submitting}
              onClick={skip}
            >
              跳过
            </Button>
          )}
        </form>
        {readOnly && (
          <div className="mt-2 flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
            <span>实施前请选择修改权限</span>
            {access}
          </div>
        )}
        {error && <ErrorLine message={error} className="mt-2 text-xs" />}
      </section>
      <div className="flex min-w-0 items-center px-4 text-sm [&>button]:h-7 [&>button]:bg-transparent [&>button]:px-0! [&>button]:hover:bg-transparent">
        {model}
      </div>
    </div>
  )
}
