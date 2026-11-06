import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsBridge } from '@pi-meme/contracts/desktop'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type {
  DesktopSettings,
  SettingsSnapshot,
  SubagentCatalogSnapshot,
  SubagentDefaults,
  SubagentDefaultsPatch,
  Theme,
} from '@pi-meme/contracts/settings'

type EditorSettings = Required<Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage'>>

function readEditorSettings(snapshot: SettingsSnapshot): EditorSettings {
  return {
    showComposerHint: snapshot.settings.showComposerHint !== false,
    showContextUsage: snapshot.settings.showContextUsage !== false,
  }
}

export function useSettings(
  bridge: Pick<
    SettingsBridge,
    | 'getSettings'
    | 'getSubagents'
    | 'reloadSubagents'
    | 'selectTheme'
    | 'reloadThemes'
    | 'openThemesDirectory'
    | 'saveSettings'
    | 'saveEditorSettings'
    | 'saveSubagentDefaults'
    | 'getInstalledFonts'
    | 'importTheme'
    | 'exportTheme'
  >,
  enabled = true,
  subagentsEnabled = true,
) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [subagents, setSubagents] = useState<SubagentCatalogSnapshot | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [subagentPending, setSubagentPending] = useState<SubagentDefaultsPatch>({})
  const [subagentStatus, setSubagentStatus] = useState<Partial<Record<keyof SubagentDefaults, string>>>({})
  const [subagentFailed, setSubagentFailed] = useState<SubagentDefaultsPatch>({})
  const subagentWrites = useRef(Promise.resolve())
  const subagentLocks = useRef(new Set<keyof SubagentDefaults>())
  const settingsReadRevision = useRef(0)
  const confirmed = useRef<SettingsSnapshot | null>(null)
  const [editorSettings, setEditorSettings] = useState<EditorSettings | null>(null)
  const confirmedEditor = useRef<EditorSettings | null>(null)
  const pendingEditor = useRef<EditorSettings | null>(null)
  const editorRevision = useRef(0)
  const editorWrites = useRef(Promise.resolve())
  const lock = useRef(false)
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  function saveSubagentDefaults(patch: SubagentDefaultsPatch) {
    if (!enabled || !snapshot) return
    const field = Object.keys(patch)[0] as keyof SubagentDefaults
    if (!field || subagentLocks.current.has(field)) return
    subagentLocks.current.add(field)
    const targetBridge = bridgeRef.current
    setSubagentPending((previous) => ({ ...previous, ...patch }))
    setSubagentStatus((previous) => ({ ...previous, [field]: '正在保存…' }))
    subagentWrites.current = subagentWrites.current.then(async () => {
      try {
        const defaults = await targetBridge.saveSubagentDefaults(patch)
        if (targetBridge !== bridgeRef.current) return
        if (confirmed.current)
          confirmed.current = {
            ...confirmed.current,
            settings: { ...confirmed.current.settings, subagentDefaults: defaults },
          }
        setSnapshot((previous) =>
          previous ? { ...previous, settings: { ...previous.settings, subagentDefaults: defaults } } : previous,
        )
        setSubagentStatus((previous) => ({ ...previous, [field]: '' }))
        setSubagentFailed((previous) => {
          const next = { ...previous }
          delete next[field]
          return next
        })
      } catch (cause) {
        if (targetBridge !== bridgeRef.current) return
        setSubagentStatus((previous) => ({ ...previous, [field]: `保存失败：${String(cause)}` }))
        setSubagentFailed((previous) => ({ ...previous, ...patch }))
      } finally {
        subagentLocks.current.delete(field)
        setSubagentPending((previous) => {
          const next = { ...previous }
          delete next[field]
          return next
        })
      }
    })
  }
  const accept = useCallback(
    (next: SettingsSnapshot) => {
      confirmed.current = next
      setSnapshot(next)
      confirmedEditor.current = readEditorSettings(next)
      if (!pendingEditor.current) setEditorSettings(confirmedEditor.current)
    },
    [enabled],
  )
  useEffect(() => {
    if (!enabled) {
      setSnapshot(null)
      setSubagents(null)
      return
    }
    let active = true
    const refresh = () => {
      const revision = ++settingsReadRevision.current
      void bridge
        .getSettings()
        .then((next) => {
          if (active && revision === settingsReadRevision.current) accept(next)
        })
        .catch((cause) => {
          if (active) setError(String(cause))
        })
    }
    refresh()
    window.addEventListener('pi-meme:system-changed', refresh)
    return () => {
      active = false
      window.removeEventListener('pi-meme:system-changed', refresh)
    }
  }, [accept, enabled, bridge])
  useEffect(() => {
    if (!enabled || !subagentsEnabled) {
      setSubagents(null)
      return
    }
    let active = true
    void bridgeRef.current
      .getSubagents()
      .then((next) => {
        if (active) setSubagents(next)
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [enabled, subagentsEnabled])
  async function action(work: () => Promise<SettingsSnapshot | void>) {
    if (!enabled || lock.current) return undefined
    lock.current = true
    setSaving(true)
    setError('')
    try {
      const next = await work()
      if (next) accept(next)
      return next
    } catch (cause) {
      setError(String(cause))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  function saveRuntime(value: DesktopSettings) {
    return action(async () => {
      try {
        const runtime: Partial<DesktopSettings> = { ...value }
        delete runtime.showComposerHint
        delete runtime.showContextUsage
        delete runtime.appearance
        delete runtime.appearanceStorage
        delete runtime.themeId
        return await bridgeRef.current.saveSettings(runtime)
      } catch (cause) {
        try {
          accept(await bridgeRef.current.getSettings())
        } catch {
          // 保留原始保存或重连错误。
        }
        throw cause
      }
    })
  }
  function saveEditor(value: Partial<EditorSettings>) {
    if (!enabled || !snapshot) return Promise.resolve()
    const current = pendingEditor.current ?? confirmedEditor.current ?? readEditorSettings(snapshot)
    const next = {
      showComposerHint: value.showComposerHint ?? current.showComposerHint,
      showContextUsage: value.showContextUsage ?? current.showContextUsage,
    }
    const revision = ++editorRevision.current
    const editorBridge = bridgeRef.current
    pendingEditor.current = next
    setEditorSettings(next)
    setError('')
    editorWrites.current = editorWrites.current.then(async () => {
      try {
        confirmedEditor.current = readEditorSettings(await editorBridge.saveEditorSettings(next))
        if (revision === editorRevision.current) {
          pendingEditor.current = null
          setEditorSettings(confirmedEditor.current)
          setError('')
        }
      } catch (cause) {
        if (revision !== editorRevision.current) return
        try {
          confirmedEditor.current = readEditorSettings(await editorBridge.getSettings())
        } catch {
          // 读取失败时恢复最后一次确认的显示设置。
        }
        if (revision === editorRevision.current) {
          pendingEditor.current = null
          setEditorSettings(confirmedEditor.current)
          setError(`编辑器设置保存失败：${String(cause)}`)
        }
      }
    })
    return editorWrites.current
  }
  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const readRevision = ++settingsReadRevision.current
      const targetBridge = bridgeRef.current
      const next = await targetBridge.getSettings()
      if (targetBridge === bridgeRef.current && readRevision === settingsReadRevision.current) {
        accept(next)
        setError('')
      }
    } catch (cause) {
      setError(`刷新外观失败：${String(cause)}`)
    }
  }, [enabled, accept])
  return {
    refresh,
    snapshot: snapshot ? { ...snapshot, settings: { ...snapshot.settings, ...editorSettings } } : null,
    subagents,
    getInstalledFonts: () => (enabled ? bridgeRef.current.getInstalledFonts() : Promise.resolve([])),
    importTheme: () => action(async () => (await bridgeRef.current.importTheme()) ?? undefined),
    exportTheme: (theme: Theme) => action(() => bridgeRef.current.exportTheme(theme)),
    error,
    dismissError: () => setError(''),
    saving,
    reload: () => action(() => bridgeRef.current.reloadThemes()),
    openDirectory: () => action(() => bridgeRef.current.openThemesDirectory()),
    saveCapabilities: (value: { codemodeEnabled: boolean; mcpEnabled: boolean }) =>
      saveRuntime({
        ...snapshot?.settings,
        themeId: snapshot?.settings.themeId ?? 'dark',
        ...value,
      }),
    subagentDefaults: {
      model: null,
      thinkingLevel: null,
      ...snapshot?.settings.subagentDefaults,
      ...subagentPending,
    } as SubagentDefaults,
    subagentPending,
    subagentStatus,
    subagentFailed,
    saveSubagentDefaults,
    saveSubagents: async (subagentsEnabled: boolean, enabledSubagents: string[]) => {
      const next = await saveRuntime({
        ...snapshot?.settings,
        themeId: snapshot?.settings.themeId ?? 'dark',
        subagentsEnabled,
        enabledSubagents,
      })
      if (next && subagentsEnabled) setSubagents(await bridgeRef.current.getSubagents())
    },
    reloadSubagents: async () => {
      if (!enabled || !subagentsEnabled || lock.current) return
      lock.current = true
      setSaving(true)
      setError('')
      try {
        setSubagents(await bridgeRef.current.reloadSubagents())
      } catch (cause) {
        setError(String(cause))
      } finally {
        lock.current = false
        setSaving(false)
      }
    },
    saveAccessMode: (mode: AgentAccessMode) =>
      saveRuntime({
        ...snapshot?.settings,
        themeId: snapshot?.settings.themeId ?? 'dark',
        defaultAccessMode: mode,
      }),
    saveEditor,
  }
}
