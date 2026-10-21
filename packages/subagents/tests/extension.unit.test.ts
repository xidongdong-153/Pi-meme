import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { BeforeAgentStartEvent, ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { agentAvatarScenes } from '@pi-meme/contracts/collaboration'
import { create } from '../src/agent/entry'

test('协作工具和明确完成工具常驻注册，不依赖旧目录定义或Task开关', async () => {
  const tools: ToolDefinition[] = []
  const requests: unknown[] = []
  let beforeStart!: (event: BeforeAgentStartEvent) => unknown
  const [extension] = create({
    requestCollaboration: async (request) => {
      requests.push(request)
      return { agents: [] }
    },
    savePlan: async () => {
      throw new Error('本测试不保存计划')
    },
  })
  if (!extension || typeof extension === 'function') throw new Error('协作扩展必须包含命名工厂')
  await extension.factory({
    on: (name: string, handler: (event: BeforeAgentStartEvent) => unknown) => {
      if (name === 'before_agent_start') beforeStart = handler
    },
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'spawn_agent',
      'send_message',
      'followup_task',
      'interrupt_agent',
      'list_agents',
      'list_agent_models',
      'wait_agent',
      'finish_agent',
      'save_plan',
    ],
  )
  const options = {
    customPrompt: '用户系统指令保持原文',
    sections: { existing: '保留已有区块' } as Record<string, string>,
    forceSystemPrompt: undefined,
  }
  const event = {
    systemPrompt: options.customPrompt,
    systemPromptOptions: options,
  } as unknown as BeforeAgentStartEvent
  assert.equal(beforeStart(event), undefined)
  const collaboration = options.sections.app_collaboration!
  assert.match(collaboration, /internal working context/)
  assert.match(collaboration, /acceptance only when review is required/)
  assert.match(collaboration, /followup_task only for a new task/)
  options.sections.skill_usage = '后续技能区块'
  assert.equal(beforeStart(event), undefined)
  assert.equal(options.sections.app_collaboration, collaboration)
  assert.equal(options.sections.existing, '保留已有区块')
  assert.equal(options.sections.skill_usage, '后续技能区块')
  assert.equal(options.forceSystemPrompt, undefined)
  assert.equal(options.customPrompt, '用户系统指令保持原文')

  const requiredFields: Record<string, string[]> = {
    spawn_agent: ['task_name', 'message'],
    send_message: ['target', 'message'],
    followup_task: ['target', 'message'],
    interrupt_agent: ['target'],
    list_agents: [],
    list_agent_models: [],
    wait_agent: [],
    finish_agent: ['report'],
    save_plan: ['title', 'markdown'],
  }
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, /[\u4E00-\u9FFF]/u)
    const parameters = tool.parameters as { required?: string[]; additionalProperties: boolean }
    assert.deepEqual(parameters.required ?? [], requiredFields[tool.name])
    assert.equal(parameters.additionalProperties, false)
  }
  const list = tools.find((tool) => tool.name === 'list_agents')!
  await list.execute('tool-list', {}, undefined, undefined, {} as never)
  assert.deepEqual(requests, [{ method: 'list_agents', params: {} }])
  const spawn = tools.find((tool) => tool.name === 'spawn_agent')!
  const schema = spawn.parameters as {
    properties: {
      task_name: { description: string; pattern: string }
      avatar: { anyOf: Array<{ const: string }>; description: string }
      fork_turns: { description: string }
    }
    required: string[]
  }
  assert.deepEqual(
    schema.properties.avatar.anyOf.map((entry) => entry.const),
    agentAvatarScenes,
  )
  assert.equal(schema.required.includes('avatar'), false)
  const taskName = schema.properties.task_name
  assert.match(taskName.description, /snake_case.*responsibility/)
  assert.match(spawn.description, /4 active or queued.*2 child levels.*16 child identities/)
  assert.doesNotMatch(spawn.description, /target/)
  assert.match(schema.properties.avatar.description, /appearance only/)
  assert.match(schema.properties.fork_turns.description, /all \(default\).*safe, complete history boundary/)
  for (const name of ['chat_activity', 'workspace_sidebar', 'settings']) assert.ok(taskName.description.includes(name))
  for (const name of ['send_message', 'followup_task', 'interrupt_agent']) {
    const tool = tools.find((entry) => entry.name === name)!
    const parameters = tool.parameters as { properties: { target: { description: string; minLength: number } } }
    assert.match(parameters.properties.target.description, /agentId.*taskPath.*direct-child.*sibling/)
    assert.equal(parameters.properties.target.minLength, 1)
  }
  const wait = tools.find((tool) => tool.name === 'wait_agent')!
  assert.match(wait.description, /active agents and senders with unread messages/)
  assert.match(wait.description, /defaults to 30000; 0 checks immediately/)
  const waitSchema = wait.parameters as {
    properties: { timeout_ms: { minimum: number; maximum: number }; targets: { items: { description: string } } }
  }
  assert.equal(waitSchema.properties.timeout_ms.minimum, 0)
  assert.equal(waitSchema.properties.timeout_ms.maximum, 3600000)
  assert.match(waitSchema.properties.targets.items.description, /agentId.*taskPath/)
  const save = tools.find((tool) => tool.name === 'save_plan')!
  assert.match(save.description, /active or queued.*unread child results/)
  assert.match(save.description, /failures, interruptions, and unresolved limitations/)
  assert.equal(taskName.pattern, '^[a-z][a-z0-9_]{0,63}$')
  for (const name of ['chat_activity', 'scout', 'worker']) {
    const params = { task_name: name, message: '任务原文', fork_turns: 'none' }
    await spawn.execute(`tool-${name}`, params, undefined, undefined, {} as never)
    assert.deepEqual(requests.at(-1), { method: 'spawn_agent', params })
  }
  const params = {
    task_name: 'worker',
    message: '审查认证边界',
    avatar: 'security',
    fork_turns: 'none',
    model: { provider: 'fake', id: 'other' },
    thinking_level: 'low',
  }
  await spawn.execute('tool-avatar', params, undefined, undefined, {} as never)
  assert.deepEqual(requests.at(-1), { method: 'spawn_agent', params })
  const models = tools.find((tool) => tool.name === 'list_agent_models')!
  await models.execute('tool-models', {}, undefined, undefined, {} as never)
  assert.deepEqual(requests.at(-1), { method: 'list_agent_models', params: {} })
  const followup = tools.find((tool) => tool.name === 'followup_task')!
  const next = { target: 'worker', message: '继续', model: params.model, thinking_level: 'off' }
  await followup.execute('tool-followup', next, undefined, undefined, {} as never)
  assert.deepEqual(requests.at(-1), { method: 'followup_task', params: next })
  for (const tool of [spawn, followup]) {
    const selection = tool.parameters as {
      properties: {
        model: { additionalProperties: boolean; required: string[] }
        thinking_level: { anyOf: Array<{ const: string }> }
      }
    }
    assert.equal(selection.properties.model.additionalProperties, false)
    assert.deepEqual(selection.properties.model.required, ['provider', 'id'])
    assert.deepEqual(
      selection.properties.thinking_level.anyOf.map((entry) => entry.const),
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    )
    assert.match(tool.description, /only when explicitly requested by the user/)
  }
  const finish = tools.find((tool) => tool.name === 'finish_agent')!
  assert.match(finish.description, /completion intent: end your turn/)
  assert.match(finish.description, /New feedback.*cancels completion/)
  await finish.execute('tool-finish', { report: '任务已完成并通过验收' }, undefined, undefined, {} as never)
  assert.deepEqual(requests.at(-1), { method: 'finish_agent', params: { report: '任务已完成并通过验收' } })
})
