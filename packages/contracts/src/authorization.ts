import type { AgentAccessMode } from './agent-access'
import type { TaskMode } from './plan'

export type AuthorizationEffectKind =
  | 'fs.read'
  | 'fs.write'
  | 'network.read'
  | 'network.write'
  | 'process.read'
  | 'process.write'
  | 'host.write'
  | 'policy.write'
  | 'secret.read'
  | 'artifact.write'

/** Resource identities and boundaries are resolved by the trusted operation adapter. */
export type AuthorizationEffect = {
  kind: AuthorizationEffectKind
  resource: string
  boundary?: 'workspace' | 'scratch' | 'host' | 'external'
}

export type AuthorizationScope = {
  hostId: string
  projectId?: string
  sessionId?: string
  clientId?: string
}

export type AuthorizationPrincipal = {
  id: string
  kind: 'user' | 'agent' | 'plugin' | 'mcp' | 'schedule' | 'service'
}

export type AuthorizationDelegation = {
  parentPrincipalId: string
  parentRevision: string
  ancestors?: Array<{ principalId: string; scope: AuthorizationScope; policyRevision: string }>
  scope: AuthorizationScope
  effects: AuthorizationEffectKind[]
  capabilities: string[]
}

/** Host resolves this from an explicit execution target, never current UI selection. */
export type AuthorizationContext = {
  principal: AuthorizationPrincipal
  scope: AuthorizationScope
  policyRevision: string
  accessMode: AgentAccessMode
  taskMode: TaskMode
  /** Intersection of backend-enforced, installation and session capabilities. */
  capabilities: string[]
  /** Optional business/installation ceiling; absence means the access preset ceiling. */
  allowedEffects?: AuthorizationEffectKind[]
  delegation?: AuthorizationDelegation
}

export type AuthorizationOperation = {
  id: string
  /** Trusted, secret-redacted action summary shown before a human decision. */
  summary?: string
  effects: AuthorizationEffect[]
  requiredCapabilities?: string[]
  /** Only named Host-owned plan/artifact storage adapters may set this. */
  planArtifact?: boolean
  /** Only policy-allowlisted Host-local status reads/subscriptions; never paid inference, MCP or proxy I/O. */
  localReadOnly?: true
  /** Effects requiring a one-operation human approval inside the hard ceiling. */
  approvalRequired?: boolean
}

export type AuthorizationRequest = {
  context: AuthorizationContext
  operation: AuthorizationOperation
  input: unknown
  /** Stable across retries and Host restarts; never include bootId. */
  idempotencyKey: string
  grantId?: string
}

export type AuthorizationGrant = {
  id: string
  approvalId: string
  bootId: string
  nonce: string
  principalId: string
  scope: AuthorizationScope
  policyRevision: string
  inputDigest: string
  delegation?: AuthorizationDelegation
  expiresAt: number
  consumedBy?: string
  revoked?: boolean
}

export type AuthorizationApproval = {
  id: string
  bootId: string
  nonce: string
  principalId: string
  scope: AuthorizationScope
  policyRevision: string
  inputDigest: string
  delegation?: AuthorizationDelegation
  operation: AuthorizationOperation
  idempotencyKey: string
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
  grantId?: string
}

export type AuthorizationLease = {
  id: string
  nonce: string
  bootId: string
  principalId: string
  scope: AuthorizationScope
  policyRevision: string
  inputDigest: string
  delegation?: AuthorizationDelegation
  operationId: string
  /** Trusted admission marker: cancellation has no business effects to reconcile; cleanup is still awaited. */
  localReadOnly?: true
  idempotencyKey: string
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown'
  createdAt: number
  /** Admission must start before this deadline; it does not extend a grant. */
  expiresAt: number
  finishedAt?: number
  reason?: string
}

export type AuthorizationDecision =
  | { kind: 'allow'; lease: AuthorizationLease }
  | { kind: 'deny'; reason: string }
  | { kind: 'approval-required'; reason: string }

/** Host-only approval for one write/edit call; null means the target was absent at approval. */
export type AuthorizedFileMutation = {
  canonicalPath: string
  existing: { dev: string; ino: string } | null
}

export type AuthorizationSnapshot = {
  bootId: string
  scope: AuthorizationScope
  accepting: boolean
  revocations: Array<{ id: string; scope: AuthorizationScope; policyRevision?: string; reason: string }>
  approvals: AuthorizationApproval[]
  grants: AuthorizationGrant[]
  leases: AuthorizationLease[]
}
