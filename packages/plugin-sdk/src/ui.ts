import type { ReactNode } from 'react'
import type { DesktopBridge, Snapshot } from '@pi-meme/contracts/desktop'
import type { Disposer } from './scope'
import type { PluginDisplay, PluginResources } from './manifest'

export type UiPluginSlot = 'page' | 'sidebar' | 'composer' | 'tool-card' | 'status' | 'settings' | 'message'
export type UiContributionMatch = { ownerId?: string; toolName?: string; customType?: string }
export type UiContributionProps = {
  sessionId?: string
  hostId?: string
  snapshot?: Snapshot | null
  bridge: DesktopBridge
  area?: string
  builtin?: Record<string, ReactNode>
  ownerId?: string
  generation?: number
  toolName?: string
  customType?: string
  [key: string]: unknown
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
export type UiPluginContext = {
  pluginId: string
  generation: number
  iconUrl?: string
  bridge: DesktopBridge
  call: <T>(method: string, args?: unknown[]) => Promise<T>
  contribute: (contribution: UiContribution) => Disposer
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
  ui?: string
  display?: PluginDisplay
  resources?: PluginResources
  iconUrl?: string
  enabled: boolean
  status: 'active' | 'disabled' | 'pending' | 'failed'
  error?: string
}
