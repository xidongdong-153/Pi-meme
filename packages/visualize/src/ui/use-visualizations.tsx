import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { Button } from '@pi-meme/ui/components/ui/button'
import { validateVisualizationRef } from '@pi-meme/contracts/visualize'
import { useCallback, useEffect, useState } from 'react'
import type { HostApi, SessionRef } from '@pi-meme/contracts/app-host'
import type {
  VisualizationDocument,
  VisualizationRef,
  VisualizationState,
  VisualizationMessageContext,
} from '@pi-meme/contracts/visualize'
import { VisualizationPreview } from './visualization-preview'

type Summary = Omit<VisualizationDocument, 'html'>
function LoadedPreview({
  host,
  session,
  reference,
  scope,
  onOpen,
  onSubmit,
}: {
  host: HostApi
  session: SessionRef
  reference: VisualizationRef
  scope: string
  onOpen?: () => void
  onSubmit: (text: string, context: VisualizationMessageContext) => Promise<boolean>
}) {
  const [document, setDocument] = useState<VisualizationDocument>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (!host.visualizations) {
      setError('当前 Host 不支持草图')
      return
    }
    host.visualizations
      .get(session, reference)
      .then((value) => {
        if (active) setDocument(value)
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [host, session.hostId, session.sessionId, reference.id, reference.revision])
  if (error) return <p role="alert">{error}</p>
  if (!document) return <p role="status">正在读取草图…</p>
  const submit = (text: string, state: VisualizationState) =>
    onSubmit(
      `请调整草图「${document.title}」（${document.id}，第 ${document.revision} 版）。\n当前预览状态：${JSON.stringify(state)}\n\n${text}`,
      { reference: { id: document.id, revision: document.revision }, state },
    )
  return (
    <VisualizationPreview
      document={document}
      storageKey={`pi-meme:visualize:v1:${scope}:${reference.id}:${reference.revision}`}
      onOpen={onOpen}
      onSubmit={submit}
    />
  )
}
export function useVisualizations({
  host,
  session,
  revision,
  openPanel,
  onSubmit,
}: {
  host: HostApi
  session?: SessionRef
  revision: unknown
  openPanel: () => void
  onSubmit: (text: string, context: VisualizationMessageContext) => Promise<boolean>
}) {
  const scope = JSON.stringify([session?.hostId, session?.sessionId])
  const [catalog, setCatalog] = useState<{ scope: string; documents: Summary[] }>({ scope, documents: [] })
  const [selection, setSelection] = useState<{ scope: string; reference: VisualizationRef; follow?: boolean }>()
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`pi-meme:visualize-selection:${scope}`) ?? 'null')
      if (saved?.scope === scope) {
        validateVisualizationRef(saved.reference)
        setSelection({ scope, reference: saved.reference, follow: saved.follow === true })
      }
    } catch {
      /* 无效的本地选择使用最新草图。 */
    }
  }, [scope])
  const [error, setError] = useState('')
  const documents = catalog.scope === scope ? catalog.documents : []
  useEffect(() => {
    let active = true
    if (!session || !host.visualizations) return
    host.visualizations
      .list(session)
      .then((values) => {
        if (active) {
          setCatalog({ scope, documents: values })
          setError('')
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [host, scope, revision])
  const chosen = selection?.scope === scope ? selection : undefined
  const versions = documents.filter((d) => d.id === chosen?.reference.id)
  const selected =
    (chosen?.follow ? versions.at(-1) : versions.find((d) => d.revision === chosen?.reference.revision)) ??
    documents.at(-1)
  const choose = useCallback(
    (reference: VisualizationRef, follow: boolean) => {
      const value = { scope, reference: { id: reference.id, revision: reference.revision }, follow }
      setSelection(value)
      try {
        localStorage.setItem(`pi-meme:visualize-selection:${scope}`, JSON.stringify(value))
      } catch {
        /* 保留当前选择。 */
      }
    },
    [scope],
  )
  const submit = useCallback(
    async (text: string, context: VisualizationMessageContext) => {
      const accepted = await onSubmit(text, context)
      if (accepted) choose(context.reference, true)
      return accepted
    },
    [onSubmit, choose],
  )
  const designs = [...new Map(documents.map((d) => [d.id, d])).values()].reverse()
  const selectedVersions = documents.filter((d) => d.id === selected?.id).reverse()
  const render = useCallback(
    (reference: VisualizationRef) =>
      session ? (
        <LoadedPreview
          key={`${scope}:${reference.id}:${reference.revision}`}
          host={host}
          session={session}
          reference={reference}
          scope={scope}
          onSubmit={submit}
          onOpen={() => {
            choose(reference, false)
            openPanel()
          }}
        />
      ) : (
        <p>会话不可用。</p>
      ),
    [host, scope, submit, openPanel, choose],
  )
  const panel = (
    <div className="space-y-3 overflow-y-auto p-3">
      {error && <p role="alert">{error}</p>}
      {selected && session ? (
        <>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <span className="text-sm text-muted-foreground">草图</span>
            <Select
              value={selected.id}
              onValueChange={(value) => {
                const d = designs.find((d) => d.id === value)
                if (d) choose(d, true)
              }}
            >
              <SelectTrigger aria-label="选择草图">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {designs.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">版本</span>
            <Select
              value={String(selected.revision)}
              onValueChange={(value) => {
                const d = selectedVersions.find((d) => d.revision === Number(value))
                if (d) choose(d, d === selectedVersions[0])
              }}
            >
              <SelectTrigger aria-label="选择版本">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectedVersions.map((d) => (
                  <SelectItem key={d.revision} value={String(d.revision)}>
                    第 {d.revision} 版{d === selectedVersions[0] ? '（最新）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected !== selectedVersions[0] && (
            <Button variant="ghost" size="sm" onClick={() => choose(selectedVersions[0], true)}>
              查看最新版本
            </Button>
          )}
          <LoadedPreview
            key={`${scope}:${selected.id}:${selected.revision}`}
            host={host}
            session={session}
            reference={selected}
            scope={scope}
            onSubmit={submit}
          />
        </>
      ) : (
        <p>当前分支没有草图。</p>
      )}
    </div>
  )
  return { render, panel, available: documents.length > 0 }
}
