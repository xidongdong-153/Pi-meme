import { useEffect, useRef, useState } from 'react'
import { Puzzle } from 'lucide-react'
import type { DeclarativeUiSurface } from '@pi-meme/plugin-sdk/declarative-ui'
import type { PluginServerClient, PluginTarget } from '@pi-meme/plugin-sdk/rpc'
import { Button } from '@pi-meme/ui/components/ui/button'

/** 这是宿主组件。插件只能提供有限 JSON，不能提供组件、事件函数或 HTML。 */
export function DeclarativePluginSurface({
  surface,
  server,
  target,
  signal,
}: {
  surface: DeclarativeUiSurface
  server: PluginServerClient
  target: PluginTarget
  signal?: AbortSignal
}) {
  const [busy, setBusy] = useState<number | null>(null)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const targetKey = JSON.stringify(target)
  useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    pending.current = false
    setBusy(null)
    setResult('')
    setError('')
    return () => {
      controller.abort()
      if (active.current === controller) active.current = null
    }
  }, [surface, targetKey, signal])
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      {surface.blocks.map((block, index) =>
        block.kind === 'text' ? (
          <p key={index} className="whitespace-pre-wrap break-words text-sm text-foreground">
            {block.text}
          </p>
        ) : (
          <Button
            key={index}
            className="w-fit max-w-full whitespace-normal"
            variant="outline"
            disabled={busy !== null || signal?.aborted}
            aria-busy={busy === index}
            onClick={async () => {
              const controller = active.current
              if (!controller || controller.signal.aborted || pending.current) return
              pending.current = true
              setBusy(index)
              setError('')
              const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
              try {
                const value = await server.call(block.operation, block.input ?? {}, { target, signal: combined })
                if (combined.aborted) return
                setResult((typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')).slice(0, 16000))
              } catch (cause) {
                if (!combined.aborted) setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                if (active.current === controller) {
                  pending.current = false
                  if (!combined.aborted) setBusy(null)
                }
              }
            }}
          >
            {busy === index ? '正在执行…' : block.title}
          </Button>
        ),
      )}
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <pre aria-live="polite" className="whitespace-pre-wrap break-words text-sm">
          {result}
        </pre>
      ) : null}
    </div>
  )
}

export function DeclarativePluginIcon() {
  return <Puzzle className="size-4" aria-hidden="true" />
}
