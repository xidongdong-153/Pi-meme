import { useEffect, useRef, useState } from 'react'
import { SessionNameInput, type SessionNameSuggestion } from '@pi-meme/ui/components/session-name-input'

export function SessionNamePanel({
  sessionName,
  suggestion,
  onRename,
  onClose,
}: {
  sessionName?: string
  suggestion?: SessionNameSuggestion
  onRename: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(sessionName ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  async function confirm() {
    const next = name.trim()
    if (!next) {
      setError('会话名称不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onRename(next)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="重命名会话"
      className="absolute left-0 right-0 bottom-full z-30 mb-2 rounded-2xl border border-border/80 bg-popover p-3 shadow-xl"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <label className="mb-2 block text-xs text-muted-foreground" htmlFor="session-name-input">
        重命名会话
      </label>
      <SessionNameInput
        suggestion={suggestion}
        id="session-name-input"
        ref={input}
        aria-label="会话名称"
        value={name}
        disabled={busy}
        onNameChange={(value) => {
          setName(value)
          setError('')
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          void confirm()
        }}
      />
      {error ? (
        <p role="alert" className="mt-2 break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors disabled:opacity-50"
        >
          确认
        </button>
      </div>
    </div>
  )
}
