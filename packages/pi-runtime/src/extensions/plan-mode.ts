import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { PlanToolSource, TaskMode } from '@pi-meme/contracts/plan'

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
export const planToolNames = new Set<string>([
  'read',
  'grep',
  'find',
  'ls',
  ...collaborationToolNames,
  'request_user_input',
  'save_plan',
  'bash',
  'codemode',
  'tool_search',
])

export function planCommandDecision(command: string): 'allow' | 'deny' {
  if (
    /^\s*(?:git\s+(?:commit|push|merge|reset|clean|checkout|switch|rebase|add|apply)|gh\s+(?:pr|issue|release)\s+(?:create|edit|comment|merge|close|delete)|(?:npm|pnpm)\s+(?:publish|install|add)|rm|mv|cp|mkdir|touch|chmod|tee)(?:\s|$)/.test(
      command,
    )
  )
    return 'deny'
  return 'allow'
}

function freezeInput(value: unknown, seen = new WeakSet<object>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) freezeInput(child, seen)
  Object.freeze(value)
}

export function assertPlanTool(mode: TaskMode, name: string, externalAllowed?: (name: string) => boolean) {
  if (mode === 'plan' && !planToolNames.has(name) && !externalAllowed?.(name))
    throw new Error(`规划模式不能执行工具：${name}`)
}

/** tool_call 同样覆盖 ctx.executeTool 的嵌套调用；工具隐藏之外仍检查实际执行。 */
export function createPlanGuard(
  mode: () => TaskMode,
  externalAllowed?: (name: string) => boolean,
  tools?: Map<string, PlanToolSource>,
): InlineExtension {
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
      pi.on('tool_call', (event, context) => {
        assertPlanTool(mode(), event.toolName, externalAllowed)
        if (mode() !== 'plan') return
        if (context.signal?.aborted) throw new Error('调研操作已取消')
        const source = tools?.get(event.toolName)
        const command = event.toolName === 'bash' ? String(event.input.command ?? '') : undefined
        if ((command !== undefined && planCommandDecision(command) === 'deny') || source?.readOnly === false)
          throw new Error('规划模式不允许此写入操作，请先开始执行计划')
        if (event.toolName === 'bash' && command !== undefined && /^\s*git\s/.test(command)) {
          event.input.command = command
            .replace(/^\s*git\s+/, 'git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null ')
            .replace(/\bdiff\s+/, 'diff --no-ext-diff --no-textconv ')
        }
        if (source || command !== undefined) freezeInput(event.input)
      })
      pi.on('user_bash', () => {
        assertPlanTool(mode(), 'user_bash')
      })
      pi.on('before_agent_start', () => {
        return mode() === 'plan'
          ? {
              message: {
                customType: 'pi-meme-plan',
                content: [
                  '当前为规划模式，只进行检查和分析。可以读取文件、搜索、调用可用的 MCP 查询工具，以及用 codemode 组合可用工具。命令行和可用的 MCP 调研工具默认执行，无需逐次确认；命令行在只读沙箱内运行。委派任务也必须只读。',
                  '禁止实施变更、修改业务文件、安装依赖、提交、发布或向外部写入。仅在本次调研需要时运行测试或构建，产物放入会话临时目录。可信插件不可用，明确声明破坏性写入的工具不可用。嵌套调用和子代理遵守同样限制。',
                  '子代理通过 finish_agent 返回发现，不得保存计划。所有委派任务结束或取消、未读结果均已接收后，根代理必须审阅结果，再调用 save_plan 保存最终 Markdown 计划。计划需要说明失败、中断和未解决的限制。',
                  'save_plan 是允许使用的 Host 计划保存入口，不要在工作区另建计划文件。保存计划不代表获准实施。保存失败时如实报告，工具成功前不要声称已保存。',
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
