import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { agentAvatarScenes } from '@pi-meme/contracts/collaboration'
import { create } from '../src/agent/entry'

test('协作工具和明确完成工具常驻注册，不依赖旧目录定义或Task开关', async () => {
  const tools: ToolDefinition[] = []
  const requests: unknown[] = []
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
    on: () => {},
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
      'wait_agent',
      'finish_agent',
      'save_plan',
    ],
  )
  const list = tools.find((tool) => tool.name === 'list_agents')!
  await list.execute('tool-list', {}, undefined, undefined, {} as never)
  assert.deepEqual(requests, [{ method: 'list_agents', params: {} }])
  const spawn = tools.find((tool) => tool.name === 'spawn_agent')!
  const schema = spawn.parameters as {
    properties: {
      task_name: { description: string; pattern: string }
      avatar: { anyOf: Array<{ const: string }> }
    }
    required: string[]
  }
  assert.deepEqual(
    schema.properties.avatar.anyOf.map((entry) => entry.const),
    agentAvatarScenes,
  )
  assert.equal(schema.required.includes('avatar'), false)
  const taskName = schema.properties.task_name
  assert.match(taskName.description, /子任务职责.*snake_case/)
  assert.match(spawn.description, /task_name.*任务职责.*snake_case/)
  for (const name of ['chat_activity', 'workspace_sidebar', 'settings']) {
    assert.ok(taskName.description.includes(name))
    assert.ok(spawn.description.includes(name))
  }
  assert.equal(taskName.pattern, '^[a-z][a-z0-9_]{0,63}$')
  for (const name of ['chat_activity', 'scout', 'worker']) {
    const params = { task_name: name, message: '任务原文', fork_turns: 'none' }
    await spawn.execute(`tool-${name}`, params, undefined, undefined, {} as never)
    assert.deepEqual(requests.at(-1), { method: 'spawn_agent', params })
  }
  const params = { task_name: 'worker', message: '审查认证边界', avatar: 'security', fork_turns: 'none' }
  await spawn.execute('tool-avatar', params, undefined, undefined, {} as never)
  assert.deepEqual(requests.at(-1), { method: 'spawn_agent', params })
  const finish = tools.find((tool) => tool.name === 'finish_agent')!
  await finish.execute('tool-finish', { report: '任务已完成并通过验收' }, undefined, undefined, {} as never)
  assert.deepEqual(requests.at(-1), { method: 'finish_agent', params: { report: '任务已完成并通过验收' } })
})
