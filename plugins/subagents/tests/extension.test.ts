import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { SubagentDefinition } from '../src/server/definition'
import type { AgentLike } from '../src/server/runner'
import { createSubagentExtension } from '../src/server/extension'

const definition: SubagentDefinition = {
  id: 'worker',
  description: 'Review the requested task',
  prompt: 'Perform the assigned work.',
  tools: ['read'],
  maxTurns: 8,
  path: '/tmp/worker.md',
}

test('Task 扩展列出可选 Agent，并且没有启用定义时拒绝注册', async () => {
  let tool: { name: string; description: string } | undefined
  const extension = createSubagentExtension([definition], () => ({}) as AgentLike)
  const inline = extension as Extract<InlineExtension, { factory: unknown }>
  await inline.factory({
    registerTool: (registered: { name: string; description: string }) => {
      tool = registered
    },
  } as unknown as ExtensionAPI)
  assert.equal(tool?.name, 'Task')
  assert.match(tool?.description ?? '', /worker: Review the requested task/)
  assert.throws(() => createSubagentExtension([], () => ({}) as AgentLike), /至少需要一个已启用/)
})
