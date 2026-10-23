export type SshConnectionPhase = 'unconfigured' | 'paused' | 'connecting' | 'connected' | 'retrying' | 'action-required'

export type SshConnectionInput = {
  id?: string
  name: string
  target: string
  port?: number
  identityFile?: string
  hostPort: number
  token?: string
}

export type SshConnection = Omit<SshConnectionInput, 'token' | 'id'> & {
  id: string
  hostId?: string
  hasToken: boolean
  enabled: boolean
  phase: SshConnectionPhase
  error?: string
  errorCode?: string
  nextRetryAt?: string
}

export type SshCandidate = { target: string; source: string }
export type SshCapabilities = { canManage: boolean; available: boolean; reason?: string }
