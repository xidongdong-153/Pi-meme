import type { ToolRun } from '../model/types'
import { ActionItemRow } from './activity-row'

export function ToolCallCard({ tool, className }: { tool: ToolRun; className?: string }) {
  return (
    <ActionItemRow
      item={{
        id: tool.id,
        name: tool.name,
        args: tool.args,
        result: tool.result,
        startedAt: tool.startedAt,
        durationMs: tool.durationMs,
        status: tool.status,
      }}
      className={className}
    />
  )
}
