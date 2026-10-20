import assert from 'node:assert/strict'
import { test, describe } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createAppAgent } from '../src/sdk/app-agent'
import { SdkSession } from '../src/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'

function trustedEntry(pluginId: string, generation: number, trusted: string): AgentPluginEntry {
  return {
    pluginId,
    generation,
    trusted,
    grant: { ...emptyPluginGrant(`fixture:${pluginId}`), trusted: { ui: false, server: false, agent: true } },
  }
}

async function settled(session: SdkSession) {
  const deadline = Date.now() + 5000
  while ((await session.snapshot()).state.isStreaming) {
    if (Date.now() > deadline) throw new Error('AppAgent 测试等待结束超时')
    await delay(10)
  }
}

test('AppAgent 使用 JSON Schema、文本和结构化结果，生命周期上下文与来源绑定会话', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-agent-api-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'app_echo', arguments: '{"value":"实际参数"}' } } : '完成'),
  })
  t.onTestFinished(() => fake.dispose())
  const entry = path.join(root, 'entry.mjs')
  const disposed = path.join(root, 'disposed')
  await writeFile(
    entry,
    `import {writeFile} from 'node:fs/promises'
export function activate(ctx) {
  if ('pi' in ctx || 'sdk' in ctx || 'registerSandbox' in ctx) throw new Error('不能公开 Pi 或权限策略')
  ctx.hooks.on('beforeRun', event => ({context:'附加的 App 上下文：'+event.prompt}))
  ctx.tools.register({name:'app_echo',title:'回显',description:'验证 App 工具',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},
    execute: async (params, execution) => {
      if (!execution.session.id || execution.session.cwd !== ${JSON.stringify(root)} || !execution.run.id || !(execution.signal instanceof AbortSignal)) throw new Error('执行上下文无效')
      const answer = await ctx.interaction.request([{id:'confirm',question:'继续？'}],execution.signal)
      ctx.messages.emit({type:'app-result',text:'App 消息',data:{confirmed:!answer.cancelled}})
      return {text:params.value,data:{value:params.value,sessionId:execution.session.id}}
    }})
  ctx.commands.register({name:'app_command',description:'App 命令',execute:async()=>{}})
  ctx.onDispose(()=>writeFile(${JSON.stringify(disposed)},'已释放'))
}`,
  )
  let requested = 0
  const source = trustedEntry('app-fixture', 8, entry)
  const session = new SdkSession(
    root,
    { connection: () => {}, event: () => {}, error: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    { agentSources: [source] },
  )
  t.onTestFinished(() => session.stopAndWait())
  session.configureInlineExtensions([
    createAppAgent(source, async () => {
      requested++
      return { answers: [{ id: 'confirm', value: '继续' }], cancelled: false }
    }),
  ])
  session.start(root)
  await session.snapshot()
  assert.ok((await session.getCommands()).some((command) => command.name === 'app_command'))
  await session.setModel({ provider: 'fake', id: 'first' })
  await session.prompt('运行工具')
  await settled(session)
  assert.equal(requested, 1)
  assert.match(requestText(fake.provider.requests[0]), /附加的 App 上下文：运行工具/)
  const afterTool = requestText(fake.provider.requests[1])
  for (const section of ['app_plugin_context', 'app_runtime', 'app_output']) {
    assert.equal(afterTool.split(`<${section}>`).length - 1, 1, section)
  }
  assert.match(afterTool, /附加的 App 上下文：运行工具/)
  const messages = (await session.snapshot()).messages
  const tool = messages.find((message) => message.role === 'toolResult' && message.toolName === 'app_echo')
  assert.ok(tool?.role === 'toolResult' && !tool.isError)
  assert.match(JSON.stringify(tool.content), /实际参数/)
  assert.equal((tool.details as { value: string }).value, '实际参数')
  assert.equal(tool.source?.ownerId, 'app-fixture')
  assert.equal(tool.source.generation, 8)
  assert.equal(tool.source.policyHash, source.grant!.policyHash)
  const custom = messages.find((message) => message.role === 'custom' && message.customType === 'app-result')
  assert.equal(custom?.source?.ownerId, 'app-fixture')
  assert.equal(custom?.source?.policyHash, source.grant!.policyHash)
  await session.continueCollaborationTask('继续处理子任务结果', 'default')
  await settled(session)
  assert.match(requestText(fake.provider.requests.at(-1)!), /附加的 App 上下文：继续处理子任务结果/)
  const beforePlan = fake.provider.requests.length
  await assert.rejects(session.prompt('只读分析', undefined, [], { mode: 'plan' }), /grant-required/)
  assert.equal(fake.provider.requests.length, beforePlan)
  assert.doesNotMatch(requestText(fake.provider.requests.at(-1)!), /附加的 App 上下文：只读分析/)
  await session.prompt('恢复普通任务', undefined, [], { mode: 'default' })
  await settled(session)
  const tools = fake.provider.requests.at(-1)!.tools?.map((tool: { function: { name: string } }) => tool.function.name)
  for (const name of ['write', 'bash', 'app_echo']) assert.ok(tools?.includes(name), JSON.stringify(tools))
  await session.stopAndWait()
  assert.equal(await readFile(disposed, 'utf8'), '已释放')
})

test('Plan 不导入可信 AppAgent 顶层，也不装配其工具；保留原生内部权限与计划守卫', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-agent-plan-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root)
  t.onTestFinished(() => fake.dispose())
  const entry = path.join(root, 'entry.mjs')
  const marker = path.join(root, 'imported')
  await writeFile(
    entry,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'已导入');export function activate(ctx){ctx.tools.register({name:'app_plan_forbidden',title:'外部工具',description:'不应装配',parameters:{type:'object'},execute:()=>({text:'不能执行'})})}`,
  )
  const session = new SdkSession(
    root,
    { connection: () => {}, event: () => {}, error: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  t.onTestFinished(() => session.stopAndWait())
  session.configureInlineExtensions([
    createAppAgent(trustedEntry('plan-app', 1, entry), async () => ({
      answers: [],
      cancelled: true,
    })),
  ])
  await session.setSessionMode('plan')
  session.start(root)
  await session.snapshot()
  await session.setModel({ provider: 'fake', id: 'first' })
  await session.prompt('只读分析', undefined, [], { mode: 'plan' })
  await settled(session)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  assert.ok(
    !fake.provider.requests[0].tools.some(
      (tool: { function: { name: string } }) => tool.function.name === 'app_plan_forbidden',
    ),
  )
})

test('AppAgent 拒绝原生 default 工厂', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-agent-invalid-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'entries'))
  const entry = path.join(root, 'entries/default.mjs')
  await writeFile(entry, 'export default () => {}')
  const extension = createAppAgent(trustedEntry('invalid-app', 1, entry), async () => ({
    answers: [],
    cancelled: true,
  }))
  assert.ok(typeof extension !== 'function')
  await assert.rejects(Promise.resolve(extension.factory({} as never)), /必须导出 activate/)
})

test('两个 AppAgent 使用同名消息类型时，消息来源与代次仍分别持久化', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-message-owners-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index <= 2 ? { tool: { name: `owner_tool_${index}`, arguments: '{}' } } : '完成'),
  })
  t.onTestFinished(() => fake.dispose())
  const sources = []
  for (let index = 1; index <= 2; index++) {
    const entry = path.join(root, `owner-${index}.mjs`)
    await writeFile(
      entry,
      `export function activate(ctx){ctx.tools.register({name:'owner_tool_${index}',title:'来源',description:'验证同名消息来源',parameters:{type:'object'},execute:()=>{ctx.messages.emit({type:'same-type',text:'消息${index}',data:{index:${index}}});return {text:'工具${index}'}}})}`,
    )
    sources.push(trustedEntry(`owner-${index}`, index, entry))
  }
  const session = new SdkSession(
    root,
    { connection: () => {}, event: () => {}, error: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    { agentSources: sources },
  )
  t.onTestFinished(() => session.stopAndWait())
  session.configureInlineExtensions(
    sources.map((source) => createAppAgent(source, async () => ({ answers: [], cancelled: true }))),
  )
  session.start(root)
  await session.snapshot()
  await session.setModel({ provider: 'fake', id: 'first' })
  await session.prompt('调用两个工具')
  await settled(session)
  const custom = (await session.snapshot()).messages.filter(
    (message) => message.role === 'custom' && message.customType === 'same-type',
  )
  assert.equal(custom.length, 2)
  assert.deepEqual(
    custom.map((message) => message.source?.ownerId),
    ['owner-1', 'owner-2'],
  )
  assert.deepEqual(
    custom.map((message) => message.source?.generation),
    [1, 2],
  )
  const { readSessionHistory } = await import('../src/session-history')
  const history = await readSessionHistory(session.getActiveSession().sessionFile!)
  const persisted = history.messages.filter(
    (message) => message.role === 'custom' && message.customType === 'same-type',
  )
  assert.deepEqual(
    persisted.map((message) => message.source?.ownerId),
    ['owner-1', 'owner-2'],
  )
  assert.deepEqual(
    persisted.map((message) => message.source?.policyHash),
    sources.map((entry) => entry.grant!.policyHash),
  )
})

describe('受限权限不导入可信 AppAgent 顶层，也不注册其工具', () => {
  for (const mode of ['read-only', 'workspace-write'] as const) {
    test(mode, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), `app-agent-${mode}-`))
      t.onTestFinished(() => rm(root, { recursive: true, force: true }))
      const fake = await useFakeAgent(root)
      t.onTestFinished(() => fake.dispose())
      const entry = path.join(root, 'entry.mjs')
      const marker = path.join(root, 'imported')
      await writeFile(
        entry,
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'不能导入');export function activate(ctx){ctx.tools.register({name:'restricted_app_tool',title:'外部工具',description:'受限权限不能注册',parameters:{type:'object'},execute:()=>({text:'不能执行'})})}`,
      )
      const session = new SdkSession(
        root,
        { connection: () => {}, event: () => {}, error: () => {} },
        fake.runtimePaths,
        fake.credentials,
      )
      t.onTestFinished(() => session.stopAndWait())
      session.configureInlineExtensions([
        createAppAgent(trustedEntry('restricted-app', 1, entry), async () => ({
          answers: [],
          cancelled: true,
        })),
      ])
      session.configureAccess(mode)
      session.start(root)
      await session.snapshot()
      await session.setModel({ provider: 'fake', id: 'first' })
      await session.prompt('受限权限分析')
      await settled(session)
      const request = requestText(fake.provider.requests[0])
      assert.match(request, new RegExp(`Access mode: ${mode}`))
      assert.match(request, /restrictions still apply/)
      if (mode === 'workspace-write') assert.ok(request.includes(root))
      await assert.rejects(access(marker), { code: 'ENOENT' })
      assert.ok(
        !fake.provider.requests[0].tools.some(
          (tool: { function: { name: string } }) => tool.function.name === 'restricted_app_tool',
        ),
      )
    })
  }
})
