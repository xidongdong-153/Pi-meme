import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ServiceActivityRequest } from '@pi-meme/contracts/service-activity'
import { create } from '../src/agent/entry'

test('管理服务工具使用对象参数，启动幂等身份来自真实 toolCallId，plan 禁止执行', async () => {
  const requests: ServiceActivityRequest[] = []
  let mode: 'default' | 'plan' = 'default'
  let tool:
    | { parameters: { type: string }; execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown> }
    | undefined
  const [extension] = create({
    taskMode: () => mode,
    requestActivity: async (request) => {
      requests.push(request)
      return { activities: [], revision: 0 }
    },
  })
  assert.equal(typeof extension, 'object')
  if (typeof extension === 'function') throw new Error('工具扩展应为内联工厂对象')
  await extension.factory({
    registerTool: (value: typeof tool) => {
      tool = value
    },
  } as unknown as ExtensionAPI)
  assert.equal(tool?.parameters.type, 'object')
  await tool!.execute('actual-tool-call', {
    action: 'start',
    name: 'Web',
    command: 'pnpm start:web',
    requestId: 'forged',
  })
  assert.deepEqual(requests, [
    { action: 'start', name: 'Web', command: 'pnpm start:web', cwd: undefined, requestId: 'actual-tool-call' },
  ])
  await assert.rejects(tool!.execute('missing', { action: 'start', name: 'Web' }), /name 和 command/)
  mode = 'plan'
  await assert.rejects(tool!.execute('plan', { action: 'list' }), /规划模式/)
  assert.equal(requests.length, 1)
})
