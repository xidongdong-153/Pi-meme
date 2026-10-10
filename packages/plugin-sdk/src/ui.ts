import type { ReactNode } from 'react'
import type { DesktopBridge, Snapshot } from '@pi-meme/contracts/desktop'
import type { Disposer } from './scope'

export type UiPluginSlot = 'page' | 'sidebar' | 'composer' | 'tool-card' | 'status' | 'settings'
export type UiContributionProps = {
  sessionId?: string
  hostId?: string
  snapshot?: Snapshot | null
  bridge: DesktopBridge
  area?: string
  builtin?: Record<string, ReactNode>
  [key: string]: unknown
}
export type UiContribution = {
  id: string
  slot: UiPluginSlot
  title?: string
  order?: number
  render: (props: UiContributionProps) => ReactNode
}
export type UiPluginContext = {
  pluginId: string
  generation: number
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
  enabled: boolean
  status: 'active' | 'disabled' | 'pending' | 'failed'
  error?: string
}
