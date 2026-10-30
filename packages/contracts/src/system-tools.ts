import type { SessionRef } from './app-host'

export type SystemToolRequest = { operation: string; args: unknown[]; write: boolean; callId: string }
export type SystemOperation = {
  name: string
  description: string
  parameters: string
  write: boolean
  scope: 'host' | 'session' | 'client'
}
export type SystemClientRequest = {
  id: string
  operation: string
  args: unknown[]
  session: SessionRef
  deadline: number
}
export type SystemClientReply = { id: string; result?: unknown; error?: string }
