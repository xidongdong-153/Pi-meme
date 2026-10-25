import type { UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'
import type { AppSession } from '@pi-meme/contracts/app-host'

export function sessionUiTarget(hostId: string, session?: AppSession): UiTarget {
  return {
    hostId,
    project: session?.project,
    session: session ? { hostId: session.hostId, sessionId: session.sessionId } : undefined,
  }
}

export const toolsTabId = 'builtin:tools'

export type PanelLayoutState = {
  version: 2
  tabs: string[]
  active: string
  open: boolean
  width: number
}

export function defaultPanelLayout(): PanelLayoutState {
  return { version: 2, tabs: [], active: '', open: false, width: 480 }
}

export function panelAvailable(panel: UiPanel, target: UiTarget) {
  return (
    panel.location === 'right' &&
    (panel.scope === 'app' || (panel.scope === 'project' ? Boolean(target.project) : Boolean(target.session)))
  )
}

export function panelStorageKey(hostId: string, session: string) {
  return `pi-meme:panels:v2:${JSON.stringify([hostId, session])}`
}

export function openPanel(layout: PanelLayoutState, id: string): PanelLayoutState {
  const tabs = layout.tabs.includes(id)
    ? layout.tabs
    : layout.tabs.includes(toolsTabId) && layout.active === toolsTabId && id !== toolsTabId
      ? layout.tabs.map((tab) => (tab === toolsTabId ? id : tab))
      : [...layout.tabs, id]
  return { ...layout, tabs, active: id, open: true }
}

export function closePanel(layout: PanelLayoutState, id: string): PanelLayoutState {
  const index = layout.tabs.indexOf(id)
  const tabs = layout.tabs.filter((tab) => tab !== id)
  if (!tabs.length) return { ...layout, tabs: [], active: '', open: false }
  return { ...layout, tabs, active: layout.active === id ? tabs[Math.min(index, tabs.length - 1)] : layout.active }
}

export function readPanelLayout(raw: string | null): PanelLayoutState {
  const initial = defaultPanelLayout()
  if (!raw) return initial
  try {
    const value = JSON.parse(raw) as Partial<PanelLayoutState>
    if (value.version !== 2) return initial
    if (Array.isArray(value.tabs)) {
      const tabs = [
        ...new Set(value.tabs.filter((id) => typeof id === 'string' && id.length > 0).map(migratePanelId)),
      ].slice(0, 32)
      initial.tabs = tabs
    }
    initial.active =
      typeof value.active === 'string' && initial.tabs.includes(migratePanelId(value.active))
        ? migratePanelId(value.active)
        : (initial.tabs[0] ?? '')
    if (typeof value.open === 'boolean') initial.open = value.open
    if (typeof value.width === 'number' && Number.isFinite(value.width))
      initial.width = Math.max(280, Math.min(1200, value.width))
    return initial
  } catch {
    return initial
  }
}

function migratePanelId(id: string) {
  if (['@pi-meme/file-directory:directory', '@pi-meme/file-directory:preview'].includes(id)) return 'builtin:files'
  if (id === '@pi-meme/terminal:terminal') return 'builtin:terminal'
  return id
}
