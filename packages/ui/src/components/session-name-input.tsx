import { useEffect, useEffectEvent, useRef, useState, type ComponentProps } from 'react'
import { Input } from './ui/input'

export type SessionNameSuggestion = { path: string; load: (path: string) => Promise<string | null> }

export function SessionNameInput({
  suggestion,
  onNameChange,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Input>, 'onChange'> & {
  suggestion?: SessionNameSuggestion
  onNameChange: (name: string) => void
}) {
  const edited = useRef(false)
  const [pending, setPending] = useState(false)
  const applySuggestion = useEffectEvent((name: string | null) => {
    if (name && !edited.current && !disabled) onNameChange(name)
  })
  const path = suggestion?.path
  const load = suggestion?.load
  useEffect(() => {
    if (!path || !load) return
    let open = true
    setPending(true)
    void load(path)
      .then((name) => {
        if (open) applySuggestion(name)
      })
      .catch(() => {})
      .finally(() => {
        if (open) setPending(false)
      })
    return () => {
      open = false
    }
  }, [path, load])
  return (
    <>
      <Input
        {...props}
        disabled={disabled}
        onChange={(event) => {
          edited.current = true
          setPending(false)
          onNameChange(event.target.value)
        }}
      />
      {pending && (
        <p role="status" className="mt-1.5 text-xs text-muted-foreground">
          正在生成名称建议…
        </p>
      )}
    </>
  )
}
