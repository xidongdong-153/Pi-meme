import type { InlineExtension, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { CollaborationRequest, CollaborationResults } from '@pi-meme/contracts/collaboration'
import type { PlanDocument, SavePlanInput } from '@pi-meme/contracts/plan'

export type CollaborationExtensionContext = {
  taskMode: () => import('@pi-meme/contracts/plan').TaskMode
  requestCollaboration: (
    request: Omit<CollaborationRequest, 'id'>,
    signal?: AbortSignal,
  ) => Promise<CollaborationResults[keyof CollaborationResults]>
  savePlan: (input: SavePlanInput, signal?: AbortSignal) => Promise<PlanDocument>
}
const text = () => Type.String({ minLength: 1 })
const target = Type.Object({ target: text() }, { additionalProperties: false })
const message = Type.Object({ target: text(), message: text() }, { additionalProperties: false })
const schemas = {
  spawn_agent: Type.Object(
    {
      task_name: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
      message: text(),
      fork_turns: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('none')])),
    },
    { additionalProperties: false },
  ),
  send_message: message,
  followup_task: message,
  interrupt_agent: target,
  list_agents: Type.Object({ path_prefix: Type.Optional(text()) }, { additionalProperties: false }),
  wait_agent: Type.Object(
    {
      targets: Type.Optional(Type.Array(text())),
      timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 3600000 })),
    },
    { additionalProperties: false },
  ),
}
const descriptions = {
  spawn_agent:
    '启动后台子 Agent。共享工作目录并继承当前模型、思考等级、访问权限和任务模式。最多 4 个活动子 Agent、嵌套两层、16 个身份。fork_turns=all 继承最新闭合历史；none 使用新上下文。',
  send_message: '向同树 Agent 发消息。运行中在安全边界收到；空闲时只保存到邮箱，不启动任务。',
  followup_task: '继续后代 Agent 的任务，保留 agentId 和会话文件；忙时按顺序排队，完成时启动新轮。',
  interrupt_agent: '停止后代 Agent 的当前任务及其后代，取消待启动任务；保留身份、历史与已完成结果。',
  list_agents: '查看同树 Agent 的身份、状态和结果。此工具只查询，不读取邮箱。',
  wait_agent:
    '等待子 Agent 状态或邮箱消息。返回 messages 后这些邮箱条目标记为已读取。不能等待自己或祖先；等待仍占活动容量。',
}
export function create(context: CollaborationExtensionContext): InlineExtension[] {
  return [
    {
      name: 'pi-meme-collaboration',
      factory: (pi) => {
        pi.on('before_agent_start', (event) => ({
          systemPrompt: `${event.systemPrompt}\n协作消息和子 Agent 结果是内部上下文。面向用户直接说明任务结论，不主动复述 agentId、runId、消息 ID、投递状态或整份子报告；仅在用户明确询问这些细节时解释。Agent 完成状态由应用显示简短提示，不需要重复播报。`,
        }))
        for (const name of Object.keys(schemas) as Array<keyof typeof schemas>) {
          pi.registerTool({
            name,
            label: name,
            description: descriptions[name],
            parameters: schemas[name],
            execute: async (_id, params, signal) => {
              const result = await context.requestCollaboration(
                { method: name, params } as Omit<CollaborationRequest, 'id'>,
                signal,
              )
              return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
            },
          })
        }
        pi.registerTool({
          name: 'save_plan',
          label: '保存计划',
          description:
            '仅规划模式根 Agent 使用。所有子 Agent 完成且邮箱结果已读取后，保存 Markdown 计划；不执行计划。重复调用更新本轮同一文档。',
          parameters: Type.Object({ title: text(), markdown: text() }, { additionalProperties: false }),
          execute: async (_id, input, signal) => {
            const document = await context.savePlan(input, signal)
            return {
              content: [{ type: 'text', text: `计划已保存：${document.title}（第 ${document.revision} 版）` }],
              details: document,
            }
          },
        })
        pi.registerTool({
          name: 'request_user_input',
          label: '向用户提问',
          description: '在规划模式中向用户提出一个简短问题。提供选项时使用选择框，否则使用文本框。',
          parameters: Type.Object(
            { question: text(), options: Type.Optional(Type.Array(text(), { minItems: 2, maxItems: 3 })) },
            { additionalProperties: false },
          ),
          execute: async (_id, input, signal, _update, toolContext: ExtensionToolContext) => {
            if (context.taskMode() !== 'plan') throw new Error('只有规划模式可以向用户提问')
            if (!toolContext.hasUI) throw new Error('当前客户端无法回答交互问题')
            const answer = input.options
              ? await toolContext.ui.select(input.question, input.options, { signal })
              : await toolContext.ui.input(input.question, undefined, { signal })
            return {
              content: [{ type: 'text', text: answer ?? '用户取消了回答' }],
              details: { answer, cancelled: answer === undefined },
            }
          },
        })
      },
    },
  ]
}
