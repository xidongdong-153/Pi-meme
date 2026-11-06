import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { PlatformAdapter } from '@pi-meme/contracts/host'
import type { AppearanceOperation, SettingsSnapshot, Theme } from '@pi-meme/contracts/settings'
import { migrateAppearance, resolveTheme, resolvedMode } from '../shared/appearance'
import { applyAppearance } from './theme/apply'
import { AppearanceSaver } from './appearance-save'

export type AppearanceController = ReturnType<typeof useAppearanceController>
const AppearanceContext = createContext<AppearanceController | null>(null)
const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

function useAppearanceController(bridge: DesktopBridge) {
  const saver = useMemo(() => new AppearanceSaver(bridge), [bridge])
  const state = useSyncExternalStore(saver.subscribe, saver.getSnapshot, saver.getSnapshot)
  const [operationError, setOperationError] = useState('')
  const maintenanceGuards = useRef(new Set<() => void>())
  const migrationAttempt = useRef<AppearanceSaver | null>(null)
  const migrationFailed = useRef<AppearanceSaver | null>(null)
  const currentSaver = useRef(saver)
  currentSaver.current = saver
  const live = useRef(false)
  const registerMaintenanceGuard = useCallback((guard: () => void) => {
    maintenanceGuards.current.add(guard)
    return () => {
      maintenanceGuards.current.delete(guard)
    }
  }, [])
  const [previewMode, setPreviewMode] = useState<'light' | 'dark' | null>(null)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [systemMotion, setSystemMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const refresh = useCallback(
    (reload = false) => {
      if (migrationFailed.current === saver) {
        migrationAttempt.current = null
        migrationFailed.current = null
        setOperationError('')
      }
      return saver.refresh(reload)
    },
    [saver],
  )
  useEffect(() => {
    saver.activate()
    live.current = true
    void saver.refresh()
    const unsubscribe = bridge.onAppearanceChanged(refresh)
    return () => {
      live.current = false
      unsubscribe()
      saver.dispose()
    }
  }, [bridge, refresh, saver])
  useEffect(() => {
    const snapshot = state.confirmed
    if (snapshot?.legacyAppearanceImport !== 'eligible' || migrationAttempt.current === saver) return
    migrationAttempt.current = saver
    void bridge
      .migrateLegacyAppearance(snapshot.appearanceRevision)
      .then((result) => {
        if (result) saver.receive(result.snapshot)
      })
      .catch((cause) => {
        if (!live.current || currentSaver.current !== saver) return
        migrationFailed.current = saver
        setOperationError(`旧外观导入失败：${causeMessage(cause)}`)
      })
  }, [bridge, saver, state.confirmed])
  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      setSystemDark(dark.matches)
      setSystemMotion(motion.matches)
    }
    dark.addEventListener('change', update)
    motion.addEventListener('change', update)
    update()
    return () => {
      dark.removeEventListener('change', update)
      motion.removeEventListener('change', update)
    }
  }, [])
  useEffect(() => {
    if (!state.snapshot) return
    const value = migrateAppearance(state.snapshot.settings, state.snapshot.themes)
    applyAppearance(
      resolveTheme(value, state.snapshot.themes, previewMode ?? resolvedMode(value, systemDark)),
      value,
      systemMotion,
    )
  }, [state.snapshot, previewMode, systemDark, systemMotion])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saver.getSnapshot().pending) event.preventDefault()
    }
    const hidden = () => {
      if (document.hidden) void saver.flush().catch(() => {})
    }
    const platform = (window as Window & { piPlatform?: PlatformAdapter }).piPlatform
    if (!platform?.lifecycle) window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', hidden)
    let preparation: { key: string; controller: AbortController } | undefined
    const unsubscribeCancel = platform?.lifecycle?.onCancel((request) => {
      if (preparation?.key !== `${request.documentGeneration}:${request.requestId}`) return
      preparation.controller.abort(new Error('窗口准备已取消'))
      preparation = undefined
      saver.setFrozen(false)
    })
    const unsubscribe = platform?.lifecycle?.onPrepare(async (request) => {
      preparation?.controller.abort(new Error('窗口准备已更新'))
      const controller = new AbortController()
      preparation = { key: `${request.documentGeneration}:${request.requestId}`, controller }
      saver.setFrozen(true)
      if (request.reason === 'maintenance') for (const guard of maintenanceGuards.current) guard()
      if (saver.getSnapshot().status === 'failed') await saver.retry(controller.signal)
      await saver.flush(controller.signal)
      if (request.reason === 'maintenance') for (const guard of maintenanceGuards.current) guard()
      // A successful preparation remains frozen until destruction or platform cancellation.
    })
    return () => {
      unsubscribe?.()
      unsubscribeCancel?.()
      preparation?.controller.abort(new Error('外观所有者已卸载'))
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [saver])
  const run = useCallback(
    async (work: () => Promise<SettingsSnapshot | void | null>) => {
      setOperationError('')
      try {
        const snapshot = await work()
        if (snapshot) saver.receive(snapshot)
      } catch (cause) {
        setOperationError(causeMessage(cause))
      }
    },
    [saver],
  )
  const onOperation = useCallback(
    (operation: AppearanceOperation) => {
      setOperationError('')
      try {
        saver.schedule(operation)
      } catch (cause) {
        setOperationError(causeMessage(cause))
      }
    },
    [saver],
  )
  return {
    bridge,
    registerMaintenanceGuard,
    ...state,
    error: state.error || operationError,
    saving: state.status === 'pending',
    refresh,
    onOperation,
    previewAppearance: setPreviewMode,
    flushAppearance: (signal?: AbortSignal) => saver.flush(signal),
    retryAppearance: () => run(() => saver.retry()),
    adoptLatestAppearance: () => saver.adoptLatest(),
    getInstalledFonts: () => bridge.getInstalledFonts(),
    reload: () =>
      run(async () => {
        await refresh(true)
      }),
    importTheme: () =>
      run(async () => {
        await saver.flush()
        return bridge.importTheme()
      }),
    exportTheme: (theme: Theme) => run(() => bridge.exportTheme(theme)),
    openDirectory: () => run(() => bridge.openThemesDirectory()),
  }
}

export function AppearanceProvider({ bridge, children }: { bridge: DesktopBridge; children: ReactNode }) {
  const controller = useAppearanceController(bridge)
  return <AppearanceContext value={controller}>{children}</AppearanceContext>
}

export function useOptionalAppearance() {
  return useContext(AppearanceContext)
}
export function useAppearance() {
  const appearance = useOptionalAppearance()
  if (!appearance) throw new Error('外观设置需要窗口级 AppearanceProvider')
  return appearance
}
