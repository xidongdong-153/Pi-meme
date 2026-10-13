import type { ReactNode } from 'react'
import type { HostApi, ProjectRef, SessionRef } from '@pi-meme/contracts/app-host'
import type { Disposer } from './scope'
import type { PluginDisplay, PluginResources } from './manifest'

export type UiPluginSlot =
  'composer' | 'composer-actions' | 'tool-card' | 'message' | 'message-actions' | 'status' | 'settings'
export type UiTarget = { hostId: string; project?: ProjectRef; session?: SessionRef }
export type UiSessionSnapshot = {
  status: string
  running: boolean
  agentPlugins: string[]
  messages: Array<{ role: string; text: string; ownerId?: string; generation?: number; type?: string; data?: unknown }>
}
export type UiReactiveState = { target: UiTarget; snapshot: UiSessionSnapshot | null }
export type UiContributionMatch = { ownerId?: string; toolName?: string; customType?: string }
export type UiContributionProps = UiReactiveState & {
  host: HostApi
  ownerId?: string
  generation?: number
  toolName?: string
  customType?: string
  tool?: unknown
  message?: unknown
}
export type UiContribution = {
  id: string
  slot: UiPluginSlot
  title?: string
  order?: number
  match?: UiContributionMatch
  generation?: number
  render: (props: UiContributionProps) => ReactNode
}
export type UiPanelLocation = 'right'
export type UiPanel = {
  id: string
  title: string
  icon: ReactNode
  location: UiPanelLocation
  generation?: number
  scope: 'app' | 'project' | 'session'
  render: (props: UiContributionProps) => ReactNode
}
export type UiPluginContext = {
  pluginId: string
  generation: number
  iconUrl?: string
  host: HostApi
  call: <T>(method: string, args?: unknown[]) => Promise<T>
  panels: { register: (panel: UiPanel) => Disposer; open: (id: string) => void }
  contributions: { register: (contribution: UiContribution) => Disposer }
  reactive: {
    subscribe: (listener: () => void) => Disposer
    getSnapshot: () => UiReactiveState
  }
}
export type UiPluginModule = {
  activate: (context: UiPluginContext) => void | Disposer | Promise<void | Disposer>
}
export type UiPluginDescriptor = {
  builtin?: boolean
  description?: string
  id: string
  version: string
  generation: number
  capabilities?: { server: boolean; agent: boolean; ui: boolean; resources: boolean }
  ui?: string
  display?: PluginDisplay
  resources?: PluginResources
  iconUrl?: string
  enabled: boolean
  status: 'active' | 'disabled' | 'pending' | 'failed'
  error?: string
}
