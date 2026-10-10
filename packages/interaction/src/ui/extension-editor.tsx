import { useEffect, useRef, type RefObject } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import type { PiExtensionDialogRequest } from '@pi-meme/contracts/pi'

export function ExtensionEditor({
  request,
  valueRef,
}: {
  request: Extract<PiExtensionDialogRequest, { method: 'editor' }>
  valueRef: RefObject<string>
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      doc: request.prefill ?? '',
      parent: host.current,
      extensions: [
        basicSetup,
        EditorView.contentAttributes.of({ 'aria-label': request.title, spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) valueRef.current = update.state.doc.toString()
        }),
      ],
    })
    view.focus()
    return () => view.destroy()
  }, [request, valueRef])
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-background min-h-[260px] max-h-[50vh] font-mono text-xs"
      ref={host}
    />
  )
}
