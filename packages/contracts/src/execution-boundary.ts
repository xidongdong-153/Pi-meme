/** Trusted Worker lifecycle. `resume` explicitly admits a new execution generation. */
export type ExecutionBoundaryListener = (reason: string, paused: boolean) => Promise<void>
export type RegisterExecutionBoundary = (listener: ExecutionBoundaryListener) => () => void
