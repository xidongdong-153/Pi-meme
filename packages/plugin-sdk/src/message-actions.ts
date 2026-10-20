import type { ReactNode } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiMessage, UiMessageActionSubject, UiMessageRole, UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import type { Disposer } from './scope'

export type UiMessageActionEligibility = { subject: UiMessageActionSubject; target: UiTarget }
export type UiMessageActionContext = UiMessageActionEligibility & {
  messages: readonly UiMessage[]
  signal: AbortSignal
  host: HostApi
}
export type UiMessageAction = {
  id: string
  title: string
  icon?: ReactNode
  order?: number
  match: {
    roles: readonly UiMessageRole[]
    source: 'self' | 'any'
    toolName?: string
    customType?: string
  }
  isEnabled?: (context: UiMessageActionEligibility) => boolean | { enabled: boolean; reason: string }
  execute: (context: UiMessageActionContext) => void | Promise<void>
}
export type RegisteredMessageAction = UiMessageAction & { pluginId: string; generation: number }
export type UiMessageActionsApi = { register: (action: UiMessageAction) => Disposer }
