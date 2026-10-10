import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { create } from '../src/agent/entry'

test('六协作工具常驻注册，不依赖旧目录定义或Task开关', async () => {
  const tools: ToolDefinition[] = []
  const requests: unknown[] = []
  const [extension] = create({
    taskMode: () => 'default',
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
      'save_plan',
      'request_user_input',
    ],
  )
  const list = tools.find((tool) => tool.name === 'list_agents')!
  await list.execute('tool-list', {}, undefined, undefined, {} as never)
  assert.deepEqual(requests, [{ method: 'list_agents', params: {} }])
  const question = tools.find((tool) => tool.name === 'request_user_input')!
  await assert.rejects(
    question.execute('tool-question', { question: '继续吗？' }, undefined, undefined, {} as never),
    /只有规划模式/,
  )
})
