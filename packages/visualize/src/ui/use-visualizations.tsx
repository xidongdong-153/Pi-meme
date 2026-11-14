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
import { visualizationStorageKey } from './visualization-state'

type Summary = Omit<VisualizationDocument, 'html'>
const documentRequests = new WeakMap<HostApi, Map<string, Promise<VisualizationDocument>>>()

function readDocument(host: HostApi, session: SessionRef, reference: VisualizationRef) {
  let requests = documentRequests.get(host)
  if (!requests) {
    requests = new Map()
    documentRequests.set(host, requests)
  }
  const key = JSON.stringify([session.hostId, session.sessionId, reference.id, reference.revision])
  const existing = requests.get(key)
  if (existing) return existing
  if (!host.visualizations) return Promise.reject(new Error('当前服务不支持可视化'))
  const pending = host.visualizations
    .get(session, { id: reference.id, revision: reference.revision })
    .finally(() => requests.delete(key))
  requests.set(key, pending)
  return pending
}

function LoadedPreview({
  host,
  session,
  reference,
  onOpen,
  onSubmit,
  rich,
}: {
  host: HostApi
  session: SessionRef
  reference: VisualizationRef
  onOpen?: () => void
  onSubmit: (text: string, context: VisualizationMessageContext) => Promise<boolean>
  rich: boolean | undefined
}) {
  const [document, setDocument] = useState<VisualizationDocument>()
  const [error, setError] = useState('')
  const [retryRevision, setRetryRevision] = useState(0)
  useEffect(() => {
    let active = true
    setError('')
    if (!host.visualizations) {
      setError('当前服务不支持可视化')
      return
    }
    readDocument(host, session, reference)
      .then((value) => {
        if (active) setDocument(value)
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [host, session.hostId, session.sessionId, reference.id, reference.revision, retryRevision])
  const failure = error && (
    <div className="flex min-w-0 items-start gap-2">
      <p role="alert" className="min-w-0 flex-1 break-words text-sm text-destructive">
        {error}
      </p>
      <Button variant="outline" size="sm" onClick={() => setRetryRevision((value) => value + 1)}>
        重试
      </Button>
    </div>
  )
  if (error && !document) return failure
  if (!document || rich === undefined)
    return (
      <p role="status" className="ui-loading-delayed text-sm text-muted-foreground">
        正在读取可视化…
      </p>
    )
  const submit = (text: string, state: VisualizationState) =>
    onSubmit(
      `请调整可视化「${document.title}」（${document.id}，第 ${document.revision} 版）。\n当前预览状态：${JSON.stringify(state)}\n\n${text}`,
      { reference: { id: document.id, revision: document.revision }, state },
    )
  return (
    <div className="min-w-0 space-y-2">
      {failure}
      <VisualizationPreview
        document={document}
        storageKey={visualizationStorageKey(session, reference)}
        rich={rich}
        onOpen={onOpen}
        onSubmit={submit}
      />
    </div>
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
  const [catalog, setCatalog] = useState<{ host: HostApi; scope: string; documents: Summary[] }>()
  const [retryRevision, setRetryRevision] = useState(0)
  const [runtime, setRuntime] = useState<{ host: HostApi; rich: boolean }>()
  const rich = runtime?.host === host ? runtime.rich : undefined
  useEffect(() => {
    let active = true
    void host
      .capabilities()
      .then((capabilities) => {
        if (active) setRuntime({ host, rich: capabilities.features.includes('visualize-runtime-v2') })
      })
      .catch(() => {
        if (active) setRuntime({ host, rich: false })
      })
    return () => {
      active = false
    }
  }, [host, retryRevision])
  const retry = useCallback(() => setRetryRevision((value) => value + 1), [])
  const [selection, setSelection] = useState<{ scope: string; reference: VisualizationRef; follow?: boolean }>()
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`pi-meme:visualize-selection:${scope}`) ?? 'null')
      if (saved?.scope === scope) {
        validateVisualizationRef(saved.reference)
        setSelection({ scope, reference: saved.reference, follow: saved.follow === true })
      }
    } catch {
      /* 无效的本地选择使用最新可视化。 */
    }
  }, [scope])
  const [failure, setFailure] = useState<{ host: HostApi; scope: string; error: string }>()
  const error = failure?.host === host && failure.scope === scope ? failure.error : ''
  const currentCatalog = catalog?.host === host && catalog.scope === scope ? catalog : undefined
  const documents = currentCatalog?.documents ?? []
  useEffect(() => {
    let active = true
    if (!session || !host.visualizations) return
    host.visualizations
      .list(session)
      .then((values) => {
        if (active) {
          setCatalog({ host, scope, documents: values })
          setFailure(undefined)
        }
      })
      .catch((cause) => {
        if (active) setFailure({ host, scope, error: String(cause) })
      })
    return () => {
      active = false
    }
  }, [host, scope, revision, retryRevision])
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
          rich={rich}
          onSubmit={submit}
          onOpen={() => {
            choose(reference, false)
            openPanel()
          }}
        />
      ) : (
        <p>会话不可用。</p>
      ),
    [host, scope, submit, openPanel, choose, rich],
  )
  const panel = (
    <div className="space-y-3 overflow-y-auto p-3">
      {error && (
        <div className="flex items-start gap-2">
          <p role="alert" className="min-w-0 flex-1 break-words">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={retry}>
            重试
          </Button>
        </div>
      )}
      {selected && session ? (
        <>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <span className="text-sm text-muted-foreground">可视化</span>
            <Select
              value={selected.id}
              onValueChange={(value) => {
                const d = designs.find((d) => d.id === value)
                if (d) choose(d, true)
              }}
            >
              <SelectTrigger aria-label="选择可视化">
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
            rich={rich}
            onSubmit={submit}
          />
        </>
      ) : !currentCatalog && !error && session ? (
        <p role="status" className="ui-loading-delayed text-sm text-muted-foreground">
          正在读取可视化…
        </p>
      ) : !error ? (
        <p>当前分支没有可视化。</p>
      ) : null}
    </div>
  )
  return {
    render,
    panel,
    available: documents.length > 0,
    status: !host.visualizations
      ? ('unsupported' as const)
      : !session
        ? ('ready' as const)
        : error
          ? ('error' as const)
          : currentCatalog
            ? ('ready' as const)
            : ('loading' as const),
    error,
    retry,
  }
}
