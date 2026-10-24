import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  agentAvatarScenes,
  type CollaborationRequest,
  type CollaborationResults,
} from '@pi-meme/contracts/collaboration'
import type { PlanDocument, SavePlanInput } from '@pi-meme/contracts/plan'
import { thinkingLevels } from '@pi-meme/contracts/pi'

export type CollaborationExtensionContext = {
  requestCollaboration: (
    request: Omit<CollaborationRequest, 'id'>,
    signal?: AbortSignal,
  ) => Promise<CollaborationResults[keyof CollaborationResults]>
  savePlan: (input: SavePlanInput, signal?: AbortSignal) => Promise<PlanDocument>
}
const text = (description: string) => Type.String({ minLength: 1, description })
const agentTarget = text(
  'An agentId, full taskPath, direct-child short name, or sibling short name. Exact IDs and paths take precedence, then a direct child, then a sibling. Use full paths across levels. Addressability does not grant management permission.',
)
const target = Type.Object({ target: agentTarget }, { additionalProperties: false })
function message(description: string) {
  return Type.Object({ target: agentTarget, message: text(description) }, { additionalProperties: false })
}
const modelSelection = {
  model: Type.Optional(
    Type.Object(
      { provider: text('已配置模型的 provider。'), id: text('已配置模型的 id。') },
      {
        additionalProperties: false,
        description:
          '仅在用户明确要求时指定；省略则使用子代理默认模型，未配置时继承主会话模型。用 list_agent_models 查询可用模型。',
      },
    ),
  ),
  thinking_level: Type.Optional(
    Type.Union(
      thinkingLevels.map((level) => Type.Literal(level)),
      {
        description:
          '仅在用户明确要求时指定；省略则使用子代理默认思考强度，未配置时继承主会话思考强度，与模型独立继承。',
      },
    ),
  ),
}
const schemas = {
  spawn_agent: Type.Object(
    {
      ...modelSelection,
      task_name: Type.String({
        pattern: '^[a-z][a-z0-9_]{0,63}$',
        description:
          "Short snake_case name for this task's responsibility, unique under the current parent; e.g. chat_activity, workspace_sidebar, settings.",
      }),
      message: text(
        'The delegated scope, context, collaborators, file ownership, and completion or required review criteria.',
      ),
      avatar: Type.Optional(
        Type.Union(
          agentAvatarScenes.map((scene) => Type.Literal(scene)),
          {
            description:
              "Display avatar for the task's role; inferred from the task name when omitted. Affects appearance only, not permissions or behavior.",
          },
        ),
      ),
      fork_turns: Type.Optional(
        Type.Union([Type.Literal('all'), Type.Literal('none')], {
          description:
            'all (default) inherits the current branch through its latest safe, complete history boundary. none omits inherited conversation messages. If safe inheritance is rejected, use none and restate the necessary context.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  send_message: message("Feedback or a question for the recipient's current task; does not start a new task."),
  followup_task: Type.Object(
    {
      target: agentTarget,
      message: text('The next task and its completion criteria; creates or queues a new run.'),
      ...modelSelection,
    },
    { additionalProperties: false },
  ),
  interrupt_agent: target,
  list_agents: Type.Object(
    {
      path_prefix: Type.Optional(
        text('Literal prefix of the full taskPath, not a glob or short-name lookup. Omit to list the whole tree.'),
      ),
    },
    { additionalProperties: false },
  ),
  list_agent_models: Type.Object({}, { additionalProperties: false }),
  wait_agent: Type.Object(
    {
      targets: Type.Optional(
        Type.Array(agentTarget, {
          description: 'Agents to watch. Omit for automatic selection; avoid an empty array. Do not include yourself.',
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 3600000,
          description: 'Maximum wait in milliseconds; defaults to 30000. Use 0 for a non-blocking check.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  finish_agent: Type.Object(
    {
      report: text(
        'Final outcome, relevant findings or changed files, verification performed, and unresolved limitations.',
      ),
    },
    { additionalProperties: false },
  ),
}
const descriptions = {
  spawn_agent:
    'Start a background child for a scoped task. Only the root may create a child. It shares the root working directory, access mode, and task mode. Override model / thinking_level only when explicitly requested by the user; omitted fields use the configured subagent defaults, then inherit the root session values. Query list_agent_models first to confirm available settings. Across the whole tree: at most 4 active or queued child identities, 1 child level (only the root may spawn children), and 16 child identities total; waiting counts as active. fork_turns defaults to all (safe, complete branch history); none starts without inherited conversation history. Include collaborators and completion criteria in message.',
  list_agent_models:
    "List currently configured and available models (provider, id, name), thinking levels, and the caller's current model and thinking level. Does not return credentials. Query before applying user-requested overrides; do not guess model identifiers.",
  send_message:
    'Send progress, questions, corrections, or review feedback within the same agent tree. A task waiting for feedback can continue in its original run and session. If the recipient belongs to another root task or has already ended, store the message in history only: deliveryState is history_only and the message does not enter the current model context. Saved does not mean read, accepted, or answered. Plan mode cannot message an agent currently running in default mode.',
  followup_task:
    "Root only: assign a new task to an existing first-level child. Reuse its identity and conversation file, preserving the root access mode and task mode. If active, queue the task until its current run ends. Use send_message for feedback or revisions within the current task. Override model / thinking_level only when explicitly requested by the user; omitted fields use the configured subagent defaults, then inherit the root session values, not the child's previous overrides. Queued tasks retain settings captured at submission.",
  interrupt_agent:
    "Stop a descendant's current run and all its descendant runs; cancel their queued or pending tasks. Only the calling agent's descendants can be interrupted. Preserve identities, history, and existing results. Interruption is not successful completion.",
  list_agents:
    'Inspect identities, execution states, and available reports in the current agent tree. Optionally filter full task paths by a literal prefix. This snapshot query does not consume or acknowledge mailbox messages.',
  wait_agent:
    'Wait for feedback from selected targets in the same agent tree, including the parent or root; do not wait for yourself. Failure, interruption, or cleanup events for the current task also wake the wait even when outside targets; inspect wakeReason and messages before continuing. Ancestors wake the wait only through messages. Omit targets to watch other active agents and senders with unread messages. timeout_ms defaults to 30000; 0 checks immediately. Messages are acknowledged only after the tool result is saved to the session. notifiedBy identifies senders whose messages are being delivered separately; do not request duplicates. A timeout does not complete the task or release an active slot; wait again when feedback is still needed.',
  finish_agent:
    'Child agents only. Submit the final report when the entire delegated task is complete and any required review is accepted. Resolve unread feedback and finish all descendant work, including queued tasks, first. Use send_message and wait_agent for interim work. Acceptance records completion intent: end your turn so the Host can publish the final result to your parent. New feedback before the run settles cancels completion; address it and call finish_agent again.',
}
export function create(context: CollaborationExtensionContext): InlineExtension[] {
  return [
    {
      name: 'pi-meme-collaboration',
      factory: (pi) => {
        pi.on('before_agent_start', (event) => {
          event.systemPromptOptions.sections.app_collaboration = [
            'Treat collaboration messages and child reports as internal working context. Present outcomes, evidence, and limitations to the user; do not expose internal agent/run/message IDs or relay entire child reports unless asked. The app already displays completion status.',
            'Use send_message for progress, review requests, corrections, and acceptance within the same task. Use wait_agent to receive feedback and continue. Use followup_task only for a new task on an existing descendant.',
            'A normal reply does not complete a child task. Satisfy the delegated criteria, obtain acceptance only when review is required, resolve unread feedback, and finish descendant work before calling finish_agent and ending the turn.',
            'Review interim feedback and terminal results; request corrections when needed. Distinguish success from failure or interruption. A returned result is not automatic acceptance. The root must account for delegated work before presenting the final outcome.',
            '子 Agent 失败时检查报告和清理状态。清理运行中或受阻时不要重启受影响的任务。旧任务轮次的消息属于历史，不能作为当前任务的指令。',
          ].join('\n')
        })
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
            'Plan-mode root agent only. Save a Markdown plan without executing it. Rejected while any child work is active or queued, or the root has unread child results. Review results and account for failures, interruptions, and unresolved limitations first. Repeated calls in the same root run update the same Host-managed document, not a workspace file. Claim it is saved only after success.',
          parameters: Type.Object(
            {
              title: text('Nonblank plan title.'),
              markdown: text(
                'Complete Markdown plan body without an outer code fence. Describe intended changes, constraints, and verification steps; do not report unperformed work as complete.',
              ),
            },
            { additionalProperties: false },
          ),
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
