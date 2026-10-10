import type {
  ExtensionAPI,
  ExtensionToolContext,
  InlineExtension,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { AgentOptions } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { SubagentDefinition } from './definition'
import { runSubagent, type AgentLike, type SubagentTaskParams } from './runner'

const taskParameters = Type.Object(
  {
    agent: Type.String({ minLength: 1, maxLength: 64 }),
    task: Type.String({ minLength: 1, maxLength: 12000 }),
    description: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { additionalProperties: false },
)

function createTaskTool(
  definitions: SubagentDefinition[],
  createAgent: (options: AgentOptions) => AgentLike,
): ToolDefinition<typeof taskParameters> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    name: 'Task',
    label: '委派子 Agent',
    description: definitions
      .map((definition) => `${definition.id}: ${definition.description}（工具：${definition.tools.join(', ')}）`)
      .join('\n'),
    promptSnippet: '把可独立完成的任务委派给已启用的子 Agent。',
    promptGuidelines: ['按 Task 工具列出的 Agent 名称委派任务；子 Agent 完成后整合其报告。'],
    parameters: taskParameters,
    executionMode: 'sequential',
    execute: async (_toolCallId, params: SubagentTaskParams, signal, _onUpdate, context: ExtensionToolContext) => {
      const definition = byId.get(params.agent)
      if (!definition) throw new Error(`子 Agent 不可用：${params.agent}`)
      return runSubagent(definition, params, signal, context, { createAgent })
    },
  }
}

export function createSubagentExtension(
  definitions: SubagentDefinition[],
  createAgent: (options: AgentOptions) => AgentLike,
): InlineExtension {
  if (!definitions.length) throw new Error('至少需要一个已启用的子 Agent 定义')
  return {
    name: 'pi-meme-subagents',
    factory: (pi: ExtensionAPI) => pi.registerTool(createTaskTool(definitions, createAgent)),
  }
}
