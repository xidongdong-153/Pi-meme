import type { ReactNode } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type {
  UiJsonValue,
  UiMessage,
  UiMessageMetadata,
  UiSessionMetadata,
  UiTarget,
} from '@pi-meme/contracts/plugin-ui-data'
import type { Disposer } from './scope'
import type { PluginDisplay, PluginResources } from './manifest'
import type { PluginGrant, PluginPermissions } from './permissions'
import type { PluginServerClient, PluginEffect } from './rpc'
import type { ComposerApi } from './composer'
import type { UiPagesApi, UiNavigationApi } from './navigation'
import type { UiMessageActionsApi } from './message-actions'
import type { UiMessagesApi, UiReactiveApi } from './reactive'

export type { UiReactiveState, UiTarget } from '@pi-meme/contracts/plugin-ui-data'

export type UiPluginSlot = 'composer' | 'composer-actions' | 'tool-card' | 'message' | 'status' | 'settings'
export type UiContributionMatch = { ownerId?: string; toolName?: string; customType?: string }
export type UiContributionProps = {
  target: UiTarget
  snapshot: UiSessionMetadata | null
  messages?: readonly UiMessageMetadata[]
  host: HostApi
  ownerId?: string
  generation?: number
  policyHash?: string
  toolName?: string
  customType?: string
  tool?: UiJsonValue
  message?: UiMessage | null
}
export type UiContribution = {
  id: string
  slot: UiPluginSlot
  title?: string
  order?: number
  match?: UiContributionMatch
  generation?: number
  policyHash?: string
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
  server: PluginServerClient
  composer: ComposerApi
  pages: UiPagesApi
  navigation: UiNavigationApi
  messageActions: UiMessageActionsApi
  panels: { register: (panel: UiPanel) => Disposer; open: (id: string) => void }
  contributions: { register: (contribution: UiContribution) => Disposer }
  reactive: UiReactiveApi
  messages: UiMessagesApi
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
  entries?: {
    agent?: { trusted: boolean; restricted: boolean }
    server?: { trusted: boolean; restricted: boolean }
  }
  operations?: readonly { name: string; effect: PluginEffect; audience: readonly ('ui' | 'agent')[] }[]
  permissions?: PluginPermissions
  grant?: PluginGrant
  grantChanging?: boolean
  policyHash?: string
  ui?: string
  display?: PluginDisplay
  resources?: PluginResources
  iconUrl?: string
  enabled: boolean
  status: 'active' | 'disabled' | 'pending' | 'failed'
  error?: string
}
