import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { TaskMode } from '@pi-meme/contracts/plan'

export const collaborationToolNames = [
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
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

export function assertPlanTool(mode: TaskMode, name: string) {
  if (mode === 'plan' && !planToolNames.has(name)) throw new Error(`规划模式不能执行工具：${name}`)
}

/** tool_call 同样覆盖 ctx.executeTool 的嵌套调用；工具隐藏之外仍检查实际执行。 */
export function createPlanGuard(mode: () => TaskMode): InlineExtension {
  return {
    name: 'pi-meme-plan-guard',
    factory: (pi) => {
      pi.on('session_start', () => {
        pi.setActiveTools(
          pi
            .getActiveTools()
            .filter((name) =>
              mode() === 'plan' ? planToolNames.has(name) : name !== 'request_user_input' && name !== 'save_plan',
            ),
        )
      })
      pi.on('tool_call', (event) => assertPlanTool(mode(), event.toolName))
      pi.on('user_bash', () => {
        assertPlanTool(mode(), 'user_bash')
      })
      pi.on('before_agent_start', () =>
        mode() === 'plan'
          ? {
              message: {
                customType: 'pi-meme-plan',
                content:
                  '当前是规划模式。只读取和分析；可以委派同样只读的子 Agent、向用户提问。完成后由根 Agent 调用 save_plan 保存 Markdown 计划，不自动执行计划。',
                display: false,
              },
            }
          : undefined,
      )
    },
  }
}
