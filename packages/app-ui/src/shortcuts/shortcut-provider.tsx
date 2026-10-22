import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PlatformAdapter } from '@pi-meme/contracts/host'
import {
  formatKeybindingDisplay,
  keybindingMatchesEvent,
  resolveKeybinding,
  SHORTCUT_DEFINITIONS,
  type ShortcutEnvironment,
  type ShortcutId,
  type ShortcutPlatform,
  type ShortcutPreferences,
} from '@pi-meme/contracts/keyboard-shortcuts'
import { loadClientShortcuts, saveClientShortcuts, WEB_STORAGE_KEY } from './shortcut-storage'

type ShortcutHandler = () => void | Promise<unknown>

export type ShortcutContextValue = {
  preferences: ShortcutPreferences
  platform: ShortcutPlatform
  environment: ShortcutEnvironment
  loading: boolean
  saving: boolean
  error: string
  save: (overrides: Partial<Record<ShortcutId, string | null>>) => Promise<void>
  binding: (id: ShortcutId) => string | null
  getShortcutLabel: (id: ShortcutId) => string | undefined
  register: (owner: symbol, handlers: Partial<Record<ShortcutId, ShortcutHandler>>) => () => void
}

export function detectPlatform(): ShortcutPlatform {
  if (typeof navigator !== 'undefined') {
    if (/Mac|Darwin|iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'darwin'
    if (/Win/i.test(navigator.userAgent)) return 'win32'
  }
  if (typeof process !== 'undefined' && process.platform) {
    if (process.platform === 'darwin') return 'darwin'
    if (process.platform === 'win32') return 'win32'
  }
  return 'linux'
}

const defaultContextValue: ShortcutContextValue = {
  preferences: { version: 1, overrides: {} },
  platform: detectPlatform(),
  environment: 'web',
  loading: false,
  saving: false,
  error: '',
  save: async () => {
    throw new Error('未配置 ShortcutProvider，无法保存快捷键')
  },
  binding: (id: ShortcutId) => {
    const def = SHORTCUT_DEFINITIONS.find((item) => item.id === id)
    return def ? resolveKeybinding(def, {}, 'web') : null
  },
  getShortcutLabel: (id: ShortcutId) => {
    const def = SHORTCUT_DEFINITIONS.find((item) => item.id === id)
    if (!def) return undefined
    const b = resolveKeybinding(def, {}, 'web')
    return b ? formatKeybindingDisplay(b, detectPlatform()) : undefined
  },
  register: () => () => {},
}

const ShortcutContext = createContext<ShortcutContextValue>(defaultContextValue)

export function useShortcuts(): ShortcutContextValue {
  return useContext(ShortcutContext)
}

export function useShortcutHandlers(
  handlers: Partial<Record<ShortcutId, ShortcutHandler | undefined>>,
  enabled = true,
) {
  const { register } = useShortcuts()
  const ownerRef = useRef<symbol>(Symbol('shortcut-owner'))
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return
    const owner = ownerRef.current
    const cleanHandlers: Partial<Record<ShortcutId, ShortcutHandler>> = {}
    for (const [key, value] of Object.entries(handlers)) {
      if (typeof value === 'function') {
        cleanHandlers[key as ShortcutId] = value
      }
    }
    return register(owner, cleanHandlers)
  }, [register, enabled, handlers])
}

export function ShortcutProvider({
  platform: platformAdapter,
  children,
}: {
  platform?: PlatformAdapter
  children: ReactNode
}) {
  const platform = useMemo(() => detectPlatform(), [])
  const environment: ShortcutEnvironment = platformAdapter?.shortcuts ? 'desktop' : 'web'

  const [preferences, setPreferences] = useState<ShortcutPreferences>({
    version: 1,
    overrides: {},
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handlersMapRef = useRef<Map<symbol, Partial<Record<ShortcutId, ShortcutHandler>>>>(new Map())
  const inFlightRef = useRef<Set<ShortcutId>>(new Set())

  const reload = useCallback(async () => {
    setError('')
    try {
      const data = await loadClientShortcuts(platformAdapter)
      setPreferences(data)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setLoading(false)
    }
  }, [platformAdapter])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (environment !== 'web' || typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      if (event.key === WEB_STORAGE_KEY) {
        void reload()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [environment, reload])

  const register = useCallback((owner: symbol, handlers: Partial<Record<ShortcutId, ShortcutHandler>>) => {
    handlersMapRef.current.set(owner, handlers)
    return () => {
      handlersMapRef.current.delete(owner)
    }
  }, [])

  const save = useCallback(
    async (overrides: Partial<Record<ShortcutId, string | null>>) => {
      setSaving(true)
      setError('')
      const next: ShortcutPreferences = { version: 1, overrides }
      try {
        await saveClientShortcuts(next, platformAdapter)
        setPreferences(next)
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause)
        setError(`快捷键保存失败：${msg}`)
        throw cause
      } finally {
        setSaving(false)
      }
    },
    [platformAdapter],
  )

  const binding = useCallback(
    (id: ShortcutId): string | null => {
      const def = SHORTCUT_DEFINITIONS.find((item) => item.id === id)
      if (!def) return null
      return resolveKeybinding(def, preferences.overrides, environment)
    },
    [preferences.overrides, environment],
  )

  const getShortcutLabel = useCallback(
    (id: ShortcutId): string | undefined => {
      const resolved = binding(id)
      if (!resolved) return undefined
      return formatKeybindingDisplay(resolved, platform)
    },
    [binding, platform],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.isComposing || event.keyCode === 229) return
      if (event.repeat) return

      const target = event.target as HTMLElement | null
      if (target) {
        if (target.closest('[data-shortcut-recording]')) return

        if (
          target.closest(
            '.cm-editor, .xterm, [data-plugin-workspace] input, [data-plugin-workspace] textarea, [data-plugin-workspace] [contenteditable="true"], [data-shortcuts-blocked]',
          )
        ) {
          return
        }

        if (target.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')) {
          return
        }

        if (
          target.tagName === 'INPUT' ||
          (target.tagName === 'TEXTAREA' && !target.classList.contains('composer-draft'))
        ) {
          return
        }
      }

      for (const def of SHORTCUT_DEFINITIONS) {
        const actionBinding = resolveKeybinding(def, preferences.overrides, environment)
        if (!actionBinding) continue

        if (keybindingMatchesEvent(actionBinding, event, platform)) {
          const owners = Array.from(handlersMapRef.current.keys()).reverse()
          for (const owner of owners) {
            const handlerMap = handlersMapRef.current.get(owner)
            const fn = handlerMap?.[def.id]
            if (typeof fn === 'function') {
              event.preventDefault()
              if (inFlightRef.current.has(def.id)) return
              try {
                const res = fn()
                if (res && typeof (res as Promise<unknown>).then === 'function') {
                  inFlightRef.current.add(def.id)
                  Promise.resolve(res)
                    .catch((err) => {
                      console.error(`快捷键动作执行失败 (${def.id}):`, err)
                    })
                    .finally(() => {
                      inFlightRef.current.delete(def.id)
                    })
                }
              } catch (err) {
                console.error(`快捷键动作执行失败 (${def.id}):`, err)
              }
              return
            }
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [preferences.overrides, environment, platform])

  const contextValue = useMemo(
    () => ({
      preferences,
      platform,
      environment,
      loading,
      saving,
      error,
      save,
      binding,
      getShortcutLabel,
      register,
    }),
    [preferences, platform, environment, loading, saving, error, save, binding, getShortcutLabel, register],
  )

  return <ShortcutContext.Provider value={contextValue}>{children}</ShortcutContext.Provider>
}
