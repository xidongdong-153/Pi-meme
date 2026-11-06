import type { SessionRef } from './app-host'

export const contextPartKinds = ['system', 'tools', 'skills', 'memory', 'files', 'results', 'chat'] as const
export type ContextPartKind = (typeof contextPartKinds)[number]
export type ContextPurpose = 'main' | 'summary' | 'cache_warm' | 'hint' | 'unknown'
export type ContextBodyState = 'memory' | 'archive' | 'off' | 'missing' | 'cut' | 'unread' | 'too-large' | 'pending'
export type ContextPiece = {
  role: 'system' | 'user' | 'assistant' | 'thinking' | 'call' | 'result' | 'tool' | 'image' | 'sealed' | ''
  name?: string
  text?: string
  src?: string
  size?: number
  characters?: number
}
export type ContextPromptItem = { id: string; name: string; tag?: string; n?: number; tokens: number }
export type ContextPromptPart = { kind: ContextPartKind; tokens: number; items: ContextPromptItem[] }
export type ContextPrompt = {
  tokens: number
  window?: number
  counted: boolean
  held?: boolean
  turns: number
  parts: ContextPromptPart[]
}
export type ContextTextItem = ContextPromptItem & { pieces: ContextPiece[] }
export type ContextUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Internal observation only: no auth headers, credentials, or environment. Never persisted in Pi JSONL. */
export type ContextRuntimeCapture = {
  id: string
  generation: number
  nativeSessionId: string
  time: string
  phase: 'payload' | 'complete' | 'failed' | 'aborted'
  payloadRevision: number
  purpose: ContextPurpose
  api: string
  model: string
  window?: number
  inputLeafId?: string
  resultEntryId?: string
  body?: string
  bodyState?: ContextBodyState
  usage?: ContextUsage
  cacheKnowledge: 'known' | 'unknown'
  reply?: ContextPiece[]
  replyCut?: boolean
  error?: string
  servedModel?: string
}
export type ContextCapture = ContextRuntimeCapture & { prompt?: ContextPrompt }
export type ContextRequest = {
  id: string
  revision: number
  payloadRevision: number
  sequence: number
  time: string
  generation: number
  nativeSessionId: string
  purpose: ContextPurpose
  api: string
  model: string
  servedModel?: string
  windowSource: 'catalog' | 'unknown'
  inputLeafId?: string
  resultEntryId?: string
  phase: ContextRuntimeCapture['phase']
  done: boolean
  prompt?: ContextPrompt
  usage?: ContextUsage
  cacheKnowledge: 'known' | 'unknown'
  bodyState: ContextBodyState
  replyState: ContextBodyState
  replyCut?: boolean
  error?: string
  parserVersion: number
}
export type ContextRequestPage = { requests: ContextRequest[]; total: number; nextCursor?: string }
export type ContextListQuery = { cursor?: string; limit?: number; includeAuxiliary?: boolean }
export type ContextItemQuery = {
  requestId: string
  payloadRevision?: number
  kind: ContextPartKind
  itemId?: string
  offset?: number
  limit?: number
}
export type ContextItemPage = {
  state: ContextBodyState
  from?: 'memory' | 'archive'
  kept: number
  items: ContextTextItem[]
  total: number
  nextOffset?: number
}
export type ContextReplyPage = {
  state: ContextBodyState
  from?: 'memory' | 'archive'
  pieces: ContextPiece[]
  cut?: boolean
}
export type ContextPieceQuery = {
  requestId: string
  payloadRevision?: number
  kind: ContextPartKind | 'reply'
  itemId?: string
  pieceIndex: number
  offset?: number
  limit?: number
}
export type ContextPiecePage = {
  state: ContextBodyState
  piece?: ContextPiece
  nextOffset?: number
  total: number
}
export type ContextImageQuery = Omit<ContextPieceQuery, 'offset' | 'limit'>
export type ContextWindowApi = {
  list: (session: SessionRef, query?: ContextListQuery) => Promise<ContextRequestPage>
  get: (session: SessionRef, requestId: string) => Promise<ContextRequest>
  item: (session: SessionRef, query: ContextItemQuery) => Promise<ContextItemPage>
  reply: (session: SessionRef, requestId: string) => Promise<ContextReplyPage>
  piece: (session: SessionRef, query: ContextPieceQuery) => Promise<ContextPiecePage>
  image: (session: SessionRef, query: ContextImageQuery) => Promise<{ state: ContextBodyState; src?: string }>
}

export const contextCaptureLimits = {
  bodyBytes: 32 * 1024 * 1024,
  retainedBytes: 64 * 1024 * 1024,
  retainedRequests: 10,
  archiveBytes: 1024 * 1024 * 1024,
  summaryBytes: 200 * 1024 * 1024,
  summaryRecordBytes: 256 * 1024,
  days: 30,
  textCharacters: 20_000,
} as const
