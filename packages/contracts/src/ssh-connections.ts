export type SshConnectionPhase = 'paused' | 'connecting' | 'connected' | 'retrying' | 'action-required'
export type SshConnectionStep = 'checking' | 'installing' | 'starting' | 'authenticating'

export type SshConnectionInput = {
  id?: string
  name?: string
  target: string
  port?: number
  identityFile?: string
}

export type SshConnection = Omit<SshConnectionInput, 'id' | 'name'> & {
  id: string
  name: string
  hostId?: string
  enabled: boolean
  phase: SshConnectionPhase
  step?: SshConnectionStep
  error?: string
  errorCode?: string
  nextRetryAt?: string
}

export type SshCandidate = { target: string; source: string }
export type SshCapabilities = { canManage: boolean; available: boolean; reason?: string }
