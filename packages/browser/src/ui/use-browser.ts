import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserAnnotation, BrowserPlatform, BrowserTab, BrowserWorkspace } from '@pi-meme/contracts/browser'

export function useBrowser({
  platform,
  owner,
  active,
  rebindFrom,
  onAnnotation,
  onDiscard,
  onSubmit,
  onSettings,
  onOpen,
}: {
  platform?: BrowserPlatform
  rebindFrom?: string
  owner: string
  active: boolean
  onAnnotation: (annotation: BrowserAnnotation, added: boolean) => void
  onDiscard: () => void
  onSubmit: () => void
  onSettings: () => void
  onOpen: (id: string) => void
}) {
  const [state, setState] = useState<{ owner: string; workspace: BrowserWorkspace; ready: boolean }>({
    owner,
    workspace: { tabs: [], annotations: [] },
    ready: false,
  })
  const [error, setError] = useState('')
  const current = useRef({ owner, active, onAnnotation, onDiscard, onSubmit, onSettings, onOpen })
  current.current = { owner, active, onAnnotation, onDiscard, onSubmit, onSettings, onOpen }
  const workspace = useRef<BrowserWorkspace>({ tabs: [], annotations: [] })
  const loaded = useRef('')
  const restorePending = useRef(new Set<string>())
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  const savingRevision = useRef(0)
  const savedRevision = useRef(0)
  const save = useCallback(
    (value: BrowserWorkspace, target: string) => {
      if (!platform) return
      const revision = ++savingRevision.current
      pending.current = pending.current
        .catch(() => {})
        .then(() => platform.saveWorkspace(target, value))
        .then(() => {
          savedRevision.current = revision
          setError('')
        })
        .catch((cause) => setError(`浏览器草稿尚未保存：${String(cause)}`))
    },
    [platform],
  )
  const update = useCallback(
    (change: (value: BrowserWorkspace) => BrowserWorkspace, persist = true) => {
      const value = change(workspace.current)
      workspace.current = value
      setState({ owner: current.current.owner, workspace: value, ready: true })
      if (persist) save(value, current.current.owner)
    },
    [save],
  )
  useEffect(() => {
    if (!platform) return
    let cancelled = false
    loaded.current = ''
    void pending.current
      .then(async () => {
        if (rebindFrom && rebindFrom !== owner) await platform.rebind(rebindFrom, owner)
        return platform.workspace(owner)
      })
      .then(async (value) => {
        if (cancelled) return
        const restored = value
        workspace.current = restored
        loaded.current = owner
        setState({ owner, workspace: restored, ready: true })
        for (const annotation of restored.annotations) {
          restorePending.current.add(annotation.id)
          current.current.onAnnotation(annotation, false)
        }
        restorePending.current.clear()
      })
      .catch((cause) => {
        if (!cancelled) setError(`无法恢复浏览器：${String(cause)}`)
      })
    return () => {
      cancelled = true
    }
  }, [platform, owner, rebindFrom])
  useEffect(() => {
    if (!platform) return
    return platform.onEvent((event) => {
      const target = current.current
      if (event.type === 'settings') {
        if (target.active) target.onSettings()
        return
      }
      if (event.type === 'submit') {
        if (event.owner === target.owner && target.active) target.onSubmit()
        return
      }
      if (event.type === 'changed') return
      if (event.type === 'discard') {
        if (event.owner === target.owner) {
          update((value) => ({ ...value, annotations: [], editor: undefined }))
          target.onDiscard()
        }
        return
      }
      if (
        (event.type === 'tab' || event.type === 'open') &&
        event.tab.owner === target.owner &&
        loaded.current === target.owner
      ) {
        const tab = event.tab
        update((value) => ({
          ...value,
          tabs: value.tabs.some((item) => item.id === tab.id)
            ? value.tabs.map((item) => (item.id === tab.id ? tab : item))
            : [...value.tabs, tab],
        }))
        if (event.type === 'open' && target.active) target.onOpen(`builtin:browser:${tab.id}`)
      }
      if (event.type === 'annotation' && event.owner === target.owner && loaded.current === target.owner) {
        if (event.annotation) {
          const annotation = event.annotation
          update((value) => ({
            ...value,
            annotations: [...value.annotations.filter((item) => item.id !== annotation.id), annotation],
            editor: undefined,
          }))
          target.onAnnotation(annotation, true)
        } else update((value) => ({ ...value, annotations: [], editor: undefined }))
      }
      if (event.type === 'editor' && event.owner === target.owner && loaded.current === target.owner)
        update((value) => ({ ...value, editor: event.annotation }))
    })
  }, [platform, update])
  const create = async (url?: string) => {
    if (!platform || loaded.current !== owner) return
    try {
      setError('')
      const id = crypto.randomUUID()
      const target = owner
      const tab = await platform.create(target, id, url)
      if (current.current.owner !== target) {
        const saved = await platform.workspace(target)
        save({ ...saved, tabs: [...saved.tabs.filter((item) => item.id !== id), tab] }, target)
        return
      }
      update((value) => ({ ...value, tabs: [...value.tabs.filter((item) => item.id !== id), tab] }))
      current.current.onOpen(`builtin:browser:${id}`)
    } catch (cause) {
      setError(String(cause))
    }
  }
  const close = async (id: string) => {
    if (!platform) return
    try {
      const target = owner
      await platform.close(id)
      if (current.current.owner !== target) {
        const saved = await platform.workspace(target)
        save({ ...saved, tabs: saved.tabs.filter((item) => item.id !== id) }, target)
        return
      }
      update((value) => ({ ...value, tabs: value.tabs.filter((item) => item.id !== id) }))
    } catch (cause) {
      setError(String(cause))
    }
  }
  const syncAnnotations = useCallback(
    (annotations: BrowserAnnotation[]) => {
      if (loaded.current !== current.current.owner) return
      if (restorePending.current.size) return
      const previous = workspace.current.annotations
      if (JSON.stringify(previous) === JSON.stringify(annotations)) return
      update((value) => ({ ...value, annotations }))
    },
    [update],
  )
  return {
    retrySave: () => save(workspace.current, current.current.owner),
    hasUnstored: () => savingRevision.current !== savedRevision.current,
    tabs: state.owner === owner ? state.workspace.tabs : ([] as BrowserTab[]),
    ready: state.owner === owner && state.ready,
    error,
    create,
    close,
    syncAnnotations,
    workspace: state.owner === owner ? state.workspace : undefined,
  }
}
