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
