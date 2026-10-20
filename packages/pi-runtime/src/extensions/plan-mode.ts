import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { TaskMode } from '@pi-meme/contracts/plan'

export const collaborationToolNames = [
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
  'finish_agent',
] as const
export const planToolNames = new Set<string>([
  'read',
  'grep',
  'find',
  'ls',
  ...collaborationToolNames,
  'request_user_input',
  'save_plan',
])

export function assertPlanTool(mode: TaskMode, name: string, externalAllowed?: (name: string) => boolean) {
  if (mode === 'plan' && !planToolNames.has(name) && !externalAllowed?.(name))
    throw new Error(`规划模式不能执行工具：${name}`)
}

/** tool_call 同样覆盖 ctx.executeTool 的嵌套调用；工具隐藏之外仍检查实际执行。 */
export function createPlanGuard(mode: () => TaskMode, externalAllowed?: (name: string) => boolean): InlineExtension {
  return {
    name: 'pi-meme-plan-guard',
    factory: (pi) => {
      pi.on('session_start', () => {
        pi.setActiveTools(
          pi
            .getActiveTools()
            .filter((name) =>
              mode() === 'plan' ? planToolNames.has(name) || externalAllowed?.(name) : name !== 'save_plan',
            ),
        )
      })
      pi.on('tool_call', (event) => assertPlanTool(mode(), event.toolName, externalAllowed))
      pi.on('user_bash', () => {
        assertPlanTool(mode(), 'user_bash')
      })
      pi.on('before_agent_start', () =>
        mode() === 'plan'
          ? {
              message: {
                customType: 'pi-meme-plan',
                content: [
                  'Plan mode is active. Inspect and analyze only. Use the available read, grep, find, ls, collaboration, request_user_input, save_plan, and explicitly authorized read-only restricted plugin tools within their role restrictions. Delegate only read-only work.',
                  'Do not execute shell commands, edit or write workspace files, run tests or builds, or use MCP, codemode, trusted plugins, or plugin write operations. These restrictions also apply when general workflow instructions ask for commands or progress files. Collaboration does not authorize implementation or bypass this mode.',
                  'Child agents return findings with finish_agent; they must not save the plan. Once no delegated work is active or queued and unread child results have been received, the root must review the results and call save_plan with the final Markdown plan. Account for failures, interruptions, and unresolved limitations.',
                  'save_plan is the permitted Host-managed plan-persistence action; do not create a separate workspace plan file. Saving does not authorize execution. Report save failures and do not claim the plan was saved unless the tool succeeds.',
                ].join('\n'),
                display: false,
              },
            }
          : undefined,
      )
    },
  }
}
