import { useReducer, useState } from 'react'
import type { UiJsonValue, UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import { sameUiTarget } from '@pi-meme/contracts/plugin-ui-data'
import type { SettingsSection } from '../settings/settings-page'

export type AppRoute =
  | { kind: 'chat' }
  | { kind: 'projects' }
  | { kind: 'materials'; section: 'all' | 'images'; image?: { hostId: string; id: string; serviceId: string } }
  | { kind: 'schedules'; taskId?: string }
  | { kind: 'customization'; section?: 'plugins' | 'skills'; selectedId?: string }
  | { kind: 'plugin'; pluginId: string; pageId: string; target: UiTarget; params: UiJsonValue }
export type AppNavigationState = { route: AppRoute; past: AppRoute[]; future: AppRoute[] }
export type AppNavigationAction =
  | { type: 'open'; route: AppRoute }
  | { type: 'replace'; route: AppRoute }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'prune'; valid: (route: AppRoute) => boolean }
type NavigationRequest =
  | Extract<AppNavigationAction, { type: 'open' | 'back' | 'forward' }>
  | { type: 'settings'; section: SettingsSection | null }
const limit = 50
export const initialAppNavigation: AppNavigationState = { route: { kind: 'chat' }, past: [], future: [] }

export function appNavigationReducer(state: AppNavigationState, action: AppNavigationAction): AppNavigationState {
  switch (action.type) {
    case 'open':
      if (JSON.stringify(state.route) === JSON.stringify(action.route)) return state
      if (
        state.route.kind === 'plugin' &&
        action.route.kind === 'plugin' &&
        state.route.pluginId === action.route.pluginId &&
        state.route.pageId === action.route.pageId &&
        sameUiTarget(state.route.target, action.route.target)
      )
        return { ...state, route: action.route }
      return { route: action.route, past: [...state.past, state.route].slice(-limit), future: [] }
    case 'replace':
      return JSON.stringify(state.route) === JSON.stringify(action.route) ? state : { ...state, route: action.route }
    case 'back': {
      const route = state.past.at(-1)
      return route
        ? { route, past: state.past.slice(0, -1), future: [state.route, ...state.future].slice(0, limit) }
        : state
    }
    case 'forward': {
      const route = state.future[0]
      return route ? { route, past: [...state.past, state.route].slice(-limit), future: state.future.slice(1) } : state
    }
    case 'prune': {
      const past = state.past.filter(action.valid)
      const future = state.future.filter(action.valid)
      const route = action.valid(state.route) ? state.route : { kind: 'chat' as const }
      return route === state.route && past.length === state.past.length && future.length === state.future.length
        ? state
        : { route, past, future }
    }
  }
}

export function useAppNavigation({
  pageDirty = false,
  settingsDirty = false,
  saving = false,
  onDiscardPage,
  onDiscardSettings,
}: {
  pageDirty?: boolean
  settingsDirty?: boolean
  saving?: boolean
  onDiscardPage?: () => void
  onDiscardSettings?: () => void
} = {}) {
  const [state, dispatch] = useReducer(appNavigationReducer, initialAppNavigation)
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({
    open: false,
    section: 'general',
  })
  const [pending, setPending] = useState<NavigationRequest | null>(null)

  function apply(action: NavigationRequest) {
    if (action.type === 'settings' && action.section !== null) {
      setSettings({ open: true, section: action.section })
    } else {
      setSettings((current) => (current.open ? { ...current, open: false } : current))
      if (action.type !== 'settings') dispatch(action)
    }
  }

  function request(action: NavigationRequest) {
    if (saving) return
    if (action.type === 'settings' && action.section === (settings.open ? settings.section : null)) return
    if (settingsDirty || (action.type !== 'settings' && pageDirty)) setPending(action)
    else apply(action)
  }

  const closeSettings = () => request({ type: 'settings', section: null })
  return {
    ...state,
    settings,
    openSettings: (section: SettingsSection = 'general') => request({ type: 'settings', section }),
    closeSettings,
    canBack: state.past.length > 0,
    canForward: state.future.length > 0,
    open: (route: AppRoute) => request({ type: 'open', route: structuredClone(route) }),
    replace: (route: AppRoute) => dispatch({ type: 'replace', route: structuredClone(route) }),
    back: () => (settings.open ? closeSettings() : request({ type: 'back' })),
    forward: () => request({ type: 'forward' }),
    home: () => request({ type: 'open', route: { kind: 'chat' } }),
    // 会话已通过离开确认并切换成功，只需显示对应聊天。
    showActiveSession: () => apply({ type: 'open', route: { kind: 'chat' } }),
    prune: (valid: (route: AppRoute) => boolean) => dispatch({ type: 'prune', valid }),
    confirmation: pending !== null,
    cancelLeave: () => setPending(null),
    discardAndLeave: () => {
      if (!pending || saving) return
      if (settingsDirty) onDiscardSettings?.()
      if (pending.type !== 'settings' && pageDirty) onDiscardPage?.()
      apply(pending)
      setPending(null)
    },
  }
}
