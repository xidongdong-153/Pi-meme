import type { SessionRef } from './app-host'

export type SystemToolRequest = { operation: string; args: unknown[]; write: boolean; callId: string }
export type SystemOperation = {
  name: string
  description: string
  parameters: string
  write: boolean
  scope: 'host' | 'session' | 'client'
  domain?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  limits?: { textBytes?: number; maxPageSize?: number; retained?: string }
}
export type SystemOperationAvailability = {
  available: boolean
  allowed: boolean
  reason?: 'not-supported' | 'not-loaded' | 'disabled' | 'disconnected' | 'permission-denied'
}
export type SystemClientIdentity = {
  connectionId: string
  registrationId: string
  documentGeneration: number
}
export type SystemClientRegistration = SystemClientIdentity & { operations: string[] }
/** 只由发起客户端创建，不进入 Host 协议；异步操作执行副作用前再次确认注册仍有效。 */
export type SystemClientExecutionContext = { assertActive: () => void }
export type SystemClientRequest = SystemClientIdentity & {
  id: string
  operation: string
  args: unknown[]
  session: SessionRef
  deadline: number
}
export type SystemClientReply = SystemClientIdentity & {
  id: string
  result?: unknown
  error?: string
  errorCode?: import('./system-read').ReadErrorCode
}
