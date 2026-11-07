/**
 * A capability is usable only when this Host's backend can enforce it.
 * filesystem-write-boundary covers resolved path roots; hardlink aliases and
 * complete secret isolation are separate requirements, never implied by it.
 * network-deny describes availability of a deny profile, not the current request's policy.
 */
export const executionCapabilities = [
  'filesystem-write-boundary',
  'host-secrets',
  'environment-isolation',
  'network-deny',
  'unix-socket-deny',
  'process-tree',
  'hardlink-write-boundary',
] as const

export type ExecutionCapability = (typeof executionCapabilities)[number]
export type ExecutionCapabilityState = {
  status: 'enforced' | 'unsupported' | 'unknown'
  reason?: string
}
export type ExecutionCapabilityReport = {
  backend: 'seatbelt' | 'bubblewrap' | 'psec' | 'unavailable'
  platform: string
  architecture: string
  checkedAt: string
  capabilities: Record<ExecutionCapability, ExecutionCapabilityState>
}

export function assertExecutionRequirements(
  report: ExecutionCapabilityReport,
  requirements: readonly ExecutionCapability[],
) {
  for (const capability of requirements) {
    const state = report.capabilities[capability]
    if (state?.status !== 'enforced')
      throw new Error(`sandbox-unavailable: ${capability}: ${state?.reason ?? state?.status ?? 'unknown'}`)
  }
}
