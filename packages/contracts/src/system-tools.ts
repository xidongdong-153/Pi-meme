import type { SessionRef } from './app-host'

export type SystemToolRequest = { operation: string; args: unknown[]; write: boolean; callId: string }
export type AgentToolAuthorizationRequest =
  | {
      phase: 'start'
      callId: string
      operationId: string
      name: string
      input: Record<string, unknown>
      adapter?: 'mcp'
    }
  | { phase: 'finish'; callId: string; operationId: string; failed: boolean }
export type AgentToolAuthorizationReply = {
  fileMutation?: import('./authorization').AuthorizedFileMutation
  fileRead?: { canonicalPath: string; dev: string; ino: string }
}
export type SystemOperation = {
  name: string
  description: string
  parameters: string
  write: boolean
  scope: 'host' | 'session' | 'client'
}
export type SystemClientRegistration = {
  registrationId: string
  documentUUID: string
  installationId: string
  connectionEpoch: string
  hostId: string
}
export type SystemClientPermit = SystemClientRegistration & {
  nonce: string
  policyRevision: string
  argumentsDigest: string
  deadline: number
  session: SessionRef
}
export type SystemClientClaim = {
  id: string
  nonce: string
  registrationId: string
  documentUUID: string
  policyRevision: string
  operation: string
  args: unknown[]
  session: SessionRef
}
export type SystemClientExecution = {
  claim: () => Promise<void>
  native: { request: SystemClientRequest; url: string; clientId: string }
}
export type SystemClientRequest = {
  id: string
  operation: string
  args: unknown[]
  session: SessionRef
  deadline: number
  permit: SystemClientPermit
}
export type SystemClientReply = { id: string; nonce: string; registrationId: string; result?: unknown; error?: string }
