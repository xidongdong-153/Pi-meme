import { useReducer, useState } from 'react'
import type { UiJsonValue, UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import { sameUiTarget } from '@pi-meme/contracts/plugin-ui-data'
import type { SettingsSection } from '../settings/settings-page'

export type AppRoute =
  | { kind: 'chat' }
  | { kind: 'projects' }
  | { kind: 'schedules'; taskId?: string }
  | { kind: 'customization'; section?: 'plugins' | 'skills'; selectedId?: string }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'plugin'; pluginId: string; pageId: string; target: UiTarget; params: UiJsonValue }
export type AppNavigationState = { route: AppRoute; past: AppRoute[]; future: AppRoute[] }
export type AppNavigationAction =
  | { type: 'open'; route: AppRoute }
  | { type: 'replace'; route: AppRoute }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'prune'; valid: (route: AppRoute) => boolean }
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
  dirty = false,
  saving = false,
  onDiscard,
}: {
  dirty?: boolean
  saving?: boolean
  onDiscard?: () => void
} = {}) {
  const [state, dispatch] = useReducer(appNavigationReducer, initialAppNavigation)
  const [pending, setPending] = useState<AppNavigationAction | null>(null)
  const request = (action: AppNavigationAction) => {
    if (saving) return
    if (dirty) setPending(action)
    else dispatch(action)
  }
  return {
    ...state,
    canBack: state.past.length > 0,
    canForward: state.future.length > 0,
    open: (route: AppRoute) => request({ type: 'open', route: structuredClone(route) }),
    replace: (route: AppRoute) => dispatch({ type: 'replace', route: structuredClone(route) }),
    back: () => request({ type: 'back' }),
    forward: () => request({ type: 'forward' }),
    home: () => request({ type: 'open', route: { kind: 'chat' } }),
    prune: (valid: (route: AppRoute) => boolean) => dispatch({ type: 'prune', valid }),
    confirmation: pending !== null,
    cancelLeave: () => setPending(null),
    discardAndLeave: () => {
      if (!pending || saving) return
      onDiscard?.()
      dispatch(pending)
      setPending(null)
    },
  }
}
