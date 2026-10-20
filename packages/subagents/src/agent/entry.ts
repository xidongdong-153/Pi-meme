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
const text = (description: string) => Type.String({ minLength: 1, description })
const agentTarget = text(
  'An agentId, full taskPath, direct-child short name, or sibling short name. Exact IDs and paths take precedence, then a direct child, then a sibling. Use full paths across levels. Addressability does not grant management permission.',
)
const target = Type.Object({ target: agentTarget }, { additionalProperties: false })
function message(description: string) {
  return Type.Object({ target: agentTarget, message: text(description) }, { additionalProperties: false })
}
const schemas = {
  spawn_agent: Type.Object(
    {
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
  followup_task: message('The next task and its completion criteria; creates or queues a new run.'),
  interrupt_agent: target,
  list_agents: Type.Object(
    {
      path_prefix: Type.Optional(
        text('Literal prefix of the full taskPath, not a glob or short-name lookup. Omit to list the whole tree.'),
      ),
    },
    { additionalProperties: false },
  ),
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
    'Start a background child for a scoped task. It shares your working directory and inherits your current model, reasoning level, access mode, and task mode. Across the whole tree: at most 4 active or queued child identities, 2 child levels, and 16 child identities total; waiting counts as active. fork_turns defaults to all (safe, complete branch history); none starts without inherited conversation history. Include collaborators and completion criteria in message.',
  send_message:
    'Send progress, questions, corrections, or acceptance feedback within the same agent tree. A task waiting for feedback may resume in its existing run and session; a terminal task only stores the message and is not restarted. Delivery does not mean read, accepted, or answered. In Plan mode, you cannot message an active agent running in default mode.',
  followup_task:
    "Assign a new task to an existing descendant of the calling agent. Reuse its identity and conversation file, but start a new run with the caller's current model, reasoning level, access mode, and task mode. If active, queue the task until its current run ends. Use send_message for feedback or revisions within the current task.",
  interrupt_agent:
    "Stop a descendant's current run and all its descendant runs; cancel their queued or pending tasks. Only the calling agent's descendants can be interrupted. Preserve identities, history, and existing results. Interruption is not successful completion.",
  list_agents:
    'Inspect identities, execution states, and available reports in the current agent tree. Optionally filter full task paths by a literal prefix. This snapshot query does not consume or acknowledge mailbox messages.',
  wait_agent:
    'Wait for feedback from selected agents in the same tree, including your parent or the root; never target yourself. Ancestors wake the wait only through messages; other targets may also wake it when the watched run ends. Omit targets to watch other active agents and senders with unread messages. timeout_ms defaults to 30000; 0 checks immediately. Returned messages are acknowledged after the tool result is recorded in the session. notifiedBy identifies senders whose messages are being delivered separately; do not request duplicate delivery. A timeout does not finish the task or release its active slot; wait again when more feedback is required.',
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
