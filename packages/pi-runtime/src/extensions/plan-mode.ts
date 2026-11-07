import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { TaskMode } from '@pi-meme/contracts/plan'
import { isBuiltinAgentToolAllowed } from '@pi-meme/contracts/agent-access'

export const collaborationToolNames = [
  'spawn_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'list_agent_models',
  'wait_agent',
  'finish_agent',
] as const

export function assertPlanTool(mode: TaskMode, name: string) {
  if (mode === 'plan' && !isBuiltinAgentToolAllowed(name, 'read-only')) throw new Error(`规划模式不能执行工具：${name}`)
}

/** 嵌套工具同样触发 tool_call；文件修改由只读沙箱拒绝，不判读命令字符串。 */
export function createPlanGuard(mode: () => TaskMode): InlineExtension {
  return {
    name: 'pi-meme-plan-guard',
    factory: (pi) => {
      pi.on('session_start', () => {
        pi.setActiveTools(
          pi
            .getActiveTools()
            .filter((name) =>
              mode() === 'plan' ? isBuiltinAgentToolAllowed(name, 'read-only') : name !== 'save_plan',
            ),
        )
      })
      pi.on('tool_call', (event, context) => {
        assertPlanTool(mode(), event.toolName)
        if (mode() !== 'plan') return
        if (context.signal?.aborted) throw new Error('调研操作已取消')
        if (event.toolName === 'manage_service' && event.input.action !== 'list' && event.input.action !== 'logs')
          throw new Error('规划模式不允许启动或停止服务')
      })
      pi.on('user_bash', () => {
        assertPlanTool(mode(), 'bash')
      })
      pi.on('before_agent_start', () => {
        return mode() === 'plan'
          ? {
              message: {
                customType: 'pi-meme-plan',
                content: [
                  '当前为规划模式，只进行检查和分析。可以读取文件、搜索，以及用 codemode 组合可用的内置工具。命令行在只读沙箱内运行，可以使用会话临时目录；委派任务也必须只读。外部插件 Agent 和 MCP 不加载。',
                  '禁止实施变更、修改业务文件、安装依赖、提交、发布或向外部写入。联网不受这套文件权限隔离，不能通过网络绕过规划规则。仅在本次调研需要时运行测试或构建，产物放入会话临时目录。嵌套调用和子代理遵守同样限制。',
                  '子代理通过 finish_agent 返回发现，不得保存计划。所有委派任务结束或取消、未读结果均已接收后，根代理必须审阅结果，再调用 save_plan 保存最终 Markdown 计划。计划需要说明失败、中断和未解决的限制。',
                  'save_plan 是允许使用的服务计划保存入口，不要在工作区另建计划文件。保存计划不代表获准实施。保存失败时如实报告，工具成功前不要声称已保存。',
                  '保存后简述结果，不重复完整计划。界面会展示计划节选，并提供实施、调整和跳过选项。',
                ].join('\n'),
                display: false,
              },
            }
          : undefined
      })
    },
  }
}
