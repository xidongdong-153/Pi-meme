import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  agentAvatarScenes,
  type CollaborationRequest,
  type CollaborationResults,
} from '@pi-meme/contracts/collaboration'
import type { PlanDocument, SavePlanInput } from '@pi-meme/contracts/plan'

export type CollaborationExtensionContext = {
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
      task_name: Type.String({
        pattern: '^[a-z][a-z0-9_]{0,63}$',
        description: '按子任务职责填写简短的 snake_case 名称，例如 chat_activity、workspace_sidebar、settings。',
      }),
      message: text(),
      avatar: Type.Optional(
        Type.Union(
          agentAvatarScenes.map((scene) => Type.Literal(scene)),
          {
            description:
              '按任务场景选择展示头像，例如 frontend（前端）、security（安全）、browser（浏览器验证）；省略时按任务名称匹配。仅影响头像。',
          },
        ),
      ),
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
  finish_agent: Type.Object({ report: text() }, { additionalProperties: false }),
}
const descriptions = {
  spawn_agent:
    '启动后台子 Agent。task_name 用任务职责的 snake_case 短名，例如 chat_activity、workspace_sidebar、settings；avatar 可按任务场景指定头像，省略时按名称匹配。target 可使用 agentId、完整 taskPath、下级或同级任务短名；重名时优先下级，跨层使用完整 taskPath。共享工作目录并继承当前模型、思考等级、访问权限和任务模式。最多 4 个活动子 Agent、嵌套两层、16 个身份。fork_turns=all 继承最新闭合历史；none 使用新上下文。委派消息写明任务、协作对象和完成条件。',
  send_message:
    '向同树 Agent 反馈进度、问题或验收意见。等待反馈中的原任务会在原会话继续；已结束任务只保存到邮箱，不重新启动。发送成功不表示对方已阅读或回复。',
  followup_task:
    '给已有后代 Agent 派发下一项任务，保留 agentId 和会话文件；忙时排队，结束后启动新轮。当前任务内的补充、反馈与修改意见使用 send_message。',
  interrupt_agent: '停止后代 Agent 的当前任务及其后代，取消待启动任务；保留身份、历史与已完成结果。',
  list_agents: '查看同树 Agent 的身份、状态和结果。此工具只查询，不读取邮箱。',
  wait_agent:
    '等待指定 Agent 的反馈；也可等待委派方或主代理的消息，不能等待自己。祖先仅按消息唤醒，其他对象也可在任务结束时唤醒。省略 targets 时等待同树其他活动代理。返回 messages 写入会话后确认已读；notifiedBy 表示反馈已走消息投递，正文会进入当前上下文，不在 messages 中重复返回。超时不结束任务，仍需等待时继续调用；等待仍占活动容量。',
  finish_agent:
    '仅子 Agent 使用。确认整个委派任务满足完成条件后提交最终 report；需要验收时先等待确认。阶段反馈使用 send_message，然后 wait_agent 等待并继续，不调用本工具。存在未完成的下级任务或未读反馈时不能完成。成功调用后结束本轮回复，应用再向委派方提交最终结果。',
}
export function create(context: CollaborationExtensionContext): InlineExtension[] {
  return [
    {
      name: 'pi-meme-collaboration',
      factory: (pi) => {
        pi.on('before_agent_start', (event) => ({
          systemPrompt: `${event.systemPrompt}\n协作消息和子 Agent 结果是内部上下文。面向用户直接说明任务结论，不主动复述 agentId、runId、消息 ID、投递状态或整份子报告；仅在用户明确询问这些细节时解释。Agent 完成状态由应用显示简短提示，不需要重复播报。\n同一任务内用 send_message 交换阶段反馈，用 wait_agent 等待委派方或其他代理的消息，再继续执行；可重复多轮。普通回复不会完成子任务。子 Agent 仅在整个委派任务完成、所需验收已确认后调用 finish_agent，然后结束回复。根 Agent 应处理阶段反馈，给出修改或验收意见；等子任务明确完成并检查结果后再给用户最终回复。followup_task 只派发下一项任务，不用于当前任务内的反馈。`,
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
      },
    },
  ]
}
