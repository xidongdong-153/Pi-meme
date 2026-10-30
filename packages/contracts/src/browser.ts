import type { ThemeColors } from './settings'

export type BrowserRect = { x: number; y: number; width: number; height: number }
export type BrowserImage = { type: 'image'; data: string; mimeType: string }
export type BrowserAnnotation = {
  id: string
  tabId: string
  documentId: number
  url: string
  title: string
  capturedAt: string
  kind: 'element' | 'region'
  text: string
  frameSelectors?: string[]
  frameUrl?: string
  selector?: string
  tag?: string
  role?: string
  name?: string
  styles?: Record<string, string>
  rect: BrowserRect
  viewport: { width: number; height: number; scale: number; scrollX: number; scrollY: number }
  comment: string
  image?: BrowserImage
}
export type BrowserTab = {
  id: string
  owner: string
  url: string
  title: string
  documentId: number
  favicon?: string
  zoom?: number
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}
export type BrowserSettings = {
  links: 'internal' | 'external'
  localLinks: 'internal' | 'external'
  search: 'bing' | 'google' | 'duckduckgo'
  fullUrl: boolean
  screenshots: 'element' | 'viewport' | 'none'
  restore: boolean
  downloadDirectory: string
  askDownload: boolean
}
export type BrowserPermission = { origin: string; permission: string; value: 'ask' | 'allow' | 'deny' }
export type BrowserHistory = { id: string; url: string; title: string; visitedAt: string }
export type BrowserDownload = {
  id: string
  url: string
  name: string
  path: string
  received: number
  total: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  createdAt: string
}
export type BrowserWorkspace = {
  tabs: BrowserTab[]
  annotations: BrowserAnnotation[]
  editor?: BrowserAnnotation
}
export type BrowserSnapshot = {
  settings: BrowserSettings
  permissions: BrowserPermission[]
  history: BrowserHistory[]
  downloads: BrowserDownload[]
}
export type BrowserEvent =
  | { type: 'tab-closed'; owner: string; id: string }
  | { type: 'tab'; tab: BrowserTab }
  | { type: 'find-result'; tabId: string; text: string; active: number; matches: number }
  | { type: 'browser-shortcut'; tabId: string; action: 'find' | 'address' | 'close-find' }
  | { type: 'annotation-mode'; tabId: string; enabled: boolean }
  | { type: 'annotation'; owner: string; annotation: BrowserAnnotation }
  | { type: 'annotation-remove'; owner: string; id: string }
  | { type: 'editor'; owner: string; annotation?: BrowserAnnotation }
  | { type: 'open'; tab: BrowserTab }
  | { type: 'submit'; owner: string }
  | { type: 'discard'; owner: string }
  | { type: 'settings' }
  | { type: 'changed' }
export type BrowserCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' | 'external' | 'focus' }
  | { type: 'zoom'; value: number }
  | { type: 'find'; text: string; forward?: boolean; next?: boolean }
  | { type: 'annotate'; enabled: boolean; region?: boolean }
  | { type: 'markers'; annotations: BrowserAnnotation[] }
  | { type: 'restore-editor'; annotation: BrowserAnnotation }
  | { type: 'annotation-state' }
  | { type: 'screenshot' }
export interface BrowserPlatform {
  agent?: (owner: string, operation: string, args: unknown[]) => Promise<unknown>
  snapshot: () => Promise<BrowserSnapshot>
  settings: (patch: Partial<BrowserSettings>) => Promise<BrowserSnapshot>
  permission: (value: BrowserPermission) => Promise<BrowserSnapshot>
  workspace: (owner: string) => Promise<BrowserWorkspace>
  saveWorkspace: (owner: string, value: BrowserWorkspace) => Promise<void>
  rebind: (from: string, to: string) => Promise<void>
  create: (owner: string, id: string, url?: string) => Promise<BrowserTab>
  close: (id: string) => Promise<void>
  present: (
    id: string,
    bounds: BrowserRect | null,
    theme?: 'dark' | 'light',
    colors?: ThemeColors,
    capturePreview?: boolean,
  ) => Promise<string | null>
  preview: (id: string) => Promise<string | null>
  command: (id: string, command: BrowserCommand) => Promise<void>
  history: (id?: string) => Promise<BrowserSnapshot>
  download: (id: string, action: 'cancel' | 'open' | 'reveal' | 'remove') => Promise<void>
  chooseDownloadDirectory: () => Promise<string | null>
  clear: (parts: Array<'history' | 'storage' | 'cache' | 'downloads'>) => Promise<void>
  openLink: (url: string, owner: string) => Promise<void>
  onEvent: (listener: (event: BrowserEvent) => void) => () => void
}
export type BrowserOverlayState = {
  kind: 'editor' | 'toolbar'
  tabId: string
  owner: string
  annotation?: BrowserAnnotation
  screenshot: BrowserSettings['screenshots']
  count: number
  enabled: boolean
  hidden: boolean
  editing: boolean
  expanded: boolean
  toolbarOffset: { x: number; y: number }
  theme: 'dark' | 'light'
  colors?: ThemeColors
  error?: string
}
export type BrowserOverlayAction =
  | { type: 'ready' | 'cancel' | 'exit' | 'submit' | 'screenshot' | 'discard' }
  | { type: 'comment'; text: string }
  | { type: 'include'; screenshot: BrowserSettings['screenshots'] }
  | { type: 'add' }
  | { type: 'expand'; expanded: boolean }
  | { type: 'resize-editor'; height: number }
  | { type: 'remove' }
  | { type: 'move-toolbar'; x: number; y: number }
  | { type: 'toolbar-menu'; open: boolean }
  | { type: 'hide'; hidden: boolean }
  | { type: 'original'; pressed: boolean }
export interface BrowserOverlayPlatform {
  state: () => Promise<BrowserOverlayState>
  action: (action: BrowserOverlayAction) => Promise<void>
  onState: (listener: (state: BrowserOverlayState) => void) => () => void
}
