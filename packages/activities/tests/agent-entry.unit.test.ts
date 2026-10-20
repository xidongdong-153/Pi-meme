import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ServiceActivityRequest } from '@pi-meme/contracts/service-activity'
import { create } from '../src/agent/entry'

test('管理服务工具使用对象参数，启动幂等身份来自真实 toolCallId，plan 禁止执行', async () => {
  const requests: ServiceActivityRequest[] = []
  let mode: 'default' | 'plan' = 'default'
  let tool:
    | {
        label: string
        description: string
        parameters: {
          type: string
          required: string[]
          additionalProperties: boolean
          properties: Record<
            string,
            { description: string; minLength?: number; maxLength?: number; anyOf?: Array<{ const: string }> }
          >
        }
        execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown>
      }
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
  assert.equal(tool?.label, '管理项目服务')
  assert.match(tool!.description, /Call list before start/)
  assert.match(tool!.description, /foreground command/)
  assert.match(tool!.description, /bash for finite builds and tests/)
  assert.match(tool!.description, /does not prove application readiness/)
  assert.match(tool!.description, /user-stopped service without explicit permission/)
  assert.match(tool!.description, /Unavailable in Plan mode/)
  assert.match(tool!.description, /macOS and Linux Hosts.*access policy/)
  const schema = tool!.parameters
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['action'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(
    schema.properties.action!.anyOf!.map((action) => action.const),
    ['start', 'list', 'logs', 'stop'],
  )
  assert.match(schema.properties.action!.description, /start requires name and command/)
  assert.match(schema.properties.action!.description, /logs and stop require serviceId/)
  assert.equal(schema.properties.name!.minLength, 1)
  assert.equal(schema.properties.name!.maxLength, 120)
  assert.equal(schema.properties.command!.minLength, 1)
  assert.equal(schema.properties.command!.maxLength, 16384)
  assert.match(schema.properties.cwd!.description, /Relative paths resolve from the session working directory/)
  assert.equal(schema.properties.cwd!.minLength, 1)
  assert.equal(schema.properties.serviceId!.minLength, 1)
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
  await tool!.execute('list', { action: 'list' })
  await tool!.execute('logs', { action: 'logs', serviceId: 'service-web' })
  await tool!.execute('stop', { action: 'stop', serviceId: 'service-web' })
  assert.deepEqual(requests.slice(1), [
    { action: 'list' },
    { action: 'logs', serviceId: 'service-web' },
    { action: 'stop', serviceId: 'service-web' },
  ])
  for (const action of ['logs', 'stop']) {
    await assert.rejects(tool!.execute('missing', { action }), /必须提供 serviceId/)
  }
  mode = 'plan'
  await assert.rejects(tool!.execute('plan', { action: 'list' }), /规划模式/)
  assert.equal(requests.length, 4)
})
