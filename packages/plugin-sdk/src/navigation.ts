import type { ReactNode } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { UiJsonValue, UiTarget } from '@pi-meme/contracts/plugin-ui-data'
import type { Disposer } from './scope'

export type UiPageProps = {
  host: HostApi
  target: UiTarget
  signal: AbortSignal
  page: {
    id: string
    params: UiJsonValue
    setParams: (params: UiJsonValue) => void
    setUnsavedChanges: (dirty: boolean) => void
  }
}
export type UiPage = {
  id: string
  title: string
  scope: 'app' | 'project' | 'session'
  render: (props: UiPageProps) => ReactNode
}
export type UiNavigation = {
  title: string
  icon?: ReactNode
  defaultPageId: string
  groups: ReadonlyArray<{
    id: string
    title?: string
    items: ReadonlyArray<{ id: string; pageId: string; title?: string; icon?: ReactNode }>
  }>
}
export type RegisteredPage = UiPage & { pluginId: string; generation: number }
export type RegisteredNavigation = UiNavigation & { pluginId: string; generation: number }
export type UiPageRequest = {
  pluginId: string
  pageId: string
  target: UiTarget
  params: UiJsonValue
  revision: number
}
export type UiPagesApi = { register: (page: UiPage) => Disposer }
export type UiNavigationApi = {
  register: (navigation: UiNavigation) => Disposer
  openPage: (pageId: string, input?: { target?: UiTarget; params?: UiJsonValue }) => Promise<void>
  back: () => void
}
