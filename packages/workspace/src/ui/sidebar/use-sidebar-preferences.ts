import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsBridge } from '@pi-meme/contracts/desktop'
import type { SidebarPreferences, SidebarPreferencesPatch } from '@pi-meme/contracts/settings'
import { type buildSidebarModel, sidebarManualOrders } from './sidebar-model'

function defaults(): SidebarPreferences {
  return {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
}

function merge(current: SidebarPreferences, patch: SidebarPreferencesPatch): SidebarPreferences {
  return {
    ...current,
    ...patch,
    collapsed: { ...current.collapsed, ...patch.collapsed },
    orders: { ...current.orders, ...patch.orders },
  }
}

export class SidebarPreferencesSaver {
  private confirmed: SidebarPreferences
  private pending: SidebarPreferencesPatch[] = []
  private writes: Promise<void> = Promise.resolve()
  private active = true

  constructor(
    initial: SidebarPreferences,
    private readonly persist: (patch: SidebarPreferencesPatch) => Promise<SidebarPreferences>,
    private readonly update: (value: SidebarPreferences) => void,
    private readonly reportError: (message: string) => void,
    initialLoad?: Promise<SidebarPreferences>,
  ) {
    this.confirmed = structuredClone(initial)
    if (initialLoad)
      this.writes = initialLoad
        .then((value) => {
          this.confirmed = structuredClone(value)
          this.publish()
        })
        .catch((cause) => {
          if (this.active) this.reportError(`侧栏设置读取失败：${String(cause)}`)
        })
  }

  private publish() {
    if (this.active) this.update(this.pending.reduce(merge, this.confirmed))
  }

  save(value: SidebarPreferencesPatch): Promise<void> {
    if (!this.active) return Promise.resolve()
    const patch = structuredClone(value)
    this.pending.push(patch)
    this.reportError('')
    this.publish()
    const next = this.writes.then(async () => {
      try {
        this.confirmed = structuredClone(await this.persist(patch))
      } catch (cause) {
        if (this.active) this.reportError(`侧栏设置保存失败：${String(cause)}`)
      } finally {
        this.pending = this.pending.filter((entry) => entry !== patch)
        this.publish()
      }
    })
    this.writes = next
    return next
  }

  dispose() {
    this.active = false
  }
}

export function useSidebarPreferences(
  bridge?: Pick<SettingsBridge, 'getSettings' | 'saveSidebarPreferences'>,
  enabled = Boolean(bridge),
) {
  const [preferences, setPreferences] = useState(defaults)
  const [loaded, setLoaded] = useState(!bridge)
  const [error, setError] = useState('')
  const saver = useRef<SidebarPreferencesSaver | null>(null)
  useEffect(() => {
    let active = true
    const initial = defaults()
    setPreferences(initial)
    setError('')
    setLoaded(!bridge)
    let local = initial
    if (!bridge || enabled) {
      const initialLoad = bridge
        ? bridge.getSettings().then((snapshot) => snapshot.settings.sidebar ?? initial)
        : undefined
      saver.current = new SidebarPreferencesSaver(
        initial,
        bridge
          ? (patch) => bridge.saveSidebarPreferences(patch)
          : async (patch) => {
              local = merge(local, patch)
              return local
            },
        setPreferences,
        setError,
        initialLoad,
      )
      if (initialLoad)
        void initialLoad.then(
          () => {
            if (active) setLoaded(true)
          },
          () => {
            if (active) setLoaded(true)
          },
        )
    }
    return () => {
      active = false
      saver.current?.dispose()
      saver.current = null
    }
  }, [bridge, enabled])
  const save = useCallback((patch: SidebarPreferencesPatch) => saver.current?.save(patch) ?? Promise.resolve(), [])
  return { preferences, loaded, error, save }
}

export function sidebarManualOrdersPatch(
  model: ReturnType<typeof buildSidebarModel>,
  preferences: SidebarPreferences,
  loaded: boolean,
  attempted: Map<string, string>,
): SidebarPreferencesPatch | undefined {
  if (!loaded) {
    attempted.clear()
    return
  }
  const orders: SidebarPreferences['orders'] = {}
  for (const [list, keys] of Object.entries(sidebarManualOrders(model, preferences.orders))) {
    if (preferences.sortMode !== 'manual' && list !== 'projects' && list !== 'pinned') continue
    if (keys === preferences.orders[list]) continue
    const attempt = JSON.stringify(keys)
    if (attempted.get(list) === attempt) continue
    attempted.set(list, attempt)
    orders[list] = keys
  }
  if (Object.keys(orders).length) return { orders }
}

export function useSidebarManualOrders(
  model: ReturnType<typeof buildSidebarModel>,
  preferences: SidebarPreferences,
  loaded: boolean,
  save: (patch: SidebarPreferencesPatch) => Promise<void>,
) {
  const attempted = useRef(new Map<string, string>())
  useEffect(() => {
    const patch = sidebarManualOrdersPatch(model, preferences, loaded, attempted.current)
    if (patch) void save(patch)
  }, [model, preferences, loaded, save])
}
