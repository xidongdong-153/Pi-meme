import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createAppAgent } from '../src/sdk/app-agent'
import { SdkSession } from '../src/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

async function settled(session: SdkSession) {
  const deadline = Date.now() + 5000
  while ((await session.snapshot()).state.isStreaming) {
    if (Date.now() > deadline) throw new Error('AppAgent 测试等待结束超时')
    await delay(10)
  }
}

test('AppAgent 使用 JSON Schema、文本和结构化结果，生命周期上下文与来源绑定会话', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-agent-api-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'app_echo', arguments: '{"value":"实际参数"}' } } : '完成'),
  })
  t.after(() => fake.dispose())
  const entry = path.join(root, 'entry.mjs')
  const disposed = path.join(root, 'disposed')
  await writeFile(
    entry,
    `import {writeFile} from 'node:fs/promises'
export function activate(ctx) {
  if ('pi' in ctx || 'sdk' in ctx || 'registerSandbox' in ctx) throw new Error('不能公开 Pi 或权限策略')
  ctx.hooks.on('beforeRun', () => ({context:'附加的 App 上下文'}))
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
  const source = { pluginId: 'app-fixture', generation: 8, path: entry }
  const session = new SdkSession(
    root,
    { connection: () => {}, event: () => {}, error: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    { agentSources: [source] },
  )
  t.after(() => session.stopAndWait())
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
  assert.match(requestText(fake.provider.requests[0]), /附加的 App 上下文/)
  const messages = (await session.snapshot()).messages
  const tool = messages.find((message) => message.role === 'toolResult' && message.toolName === 'app_echo')
  assert.ok(tool?.role === 'toolResult' && !tool.isError)
  assert.match(JSON.stringify(tool.content), /实际参数/)
  assert.equal((tool.details as { value: string }).value, '实际参数')
  assert.equal(tool.source?.ownerId, 'app-fixture')
  assert.equal(tool.source.generation, 8)
  const custom = messages.find((message) => message.role === 'custom' && message.customType === 'app-result')
  assert.equal(custom?.source?.ownerId, 'app-fixture')
  await session.stopAndWait()
  assert.equal(await readFile(disposed, 'utf8'), '已释放')
})

test('Plan 不导入 AppAgent 顶层，也不装配外部工具；保留原生内部权限与计划守卫', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-agent-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root)
  t.after(() => fake.dispose())
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
  t.after(() => session.stopAndWait())
  session.configureInlineExtensions([
    createAppAgent({ pluginId: 'plan-app', generation: 1, path: entry }, async () => ({
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
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'entries'))
  const entry = path.join(root, 'entries/default.mjs')
  await writeFile(entry, 'export default () => {}')
  const extension = createAppAgent({ pluginId: 'invalid-app', generation: 1, path: entry }, async () => ({
    answers: [],
    cancelled: true,
  }))
  assert.ok(typeof extension !== 'function')
  await assert.rejects(Promise.resolve(extension.factory({} as never)), /必须导出 activate/)
})

test('两个 AppAgent 使用同名消息类型时，消息来源与代次仍分别持久化', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-message-owners-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index <= 2 ? { tool: { name: `owner_tool_${index}`, arguments: '{}' } } : '完成'),
  })
  t.after(() => fake.dispose())
  const sources = []
  for (let index = 1; index <= 2; index++) {
    const entry = path.join(root, `owner-${index}.mjs`)
    await writeFile(
      entry,
      `export function activate(ctx){ctx.tools.register({name:'owner_tool_${index}',title:'来源',description:'验证同名消息来源',parameters:{type:'object'},execute:()=>{ctx.messages.emit({type:'same-type',text:'消息${index}',data:{index:${index}}});return {text:'工具${index}'}}})}`,
    )
    sources.push({ pluginId: `owner-${index}`, generation: index, path: entry })
  }
  const session = new SdkSession(
    root,
    { connection: () => {}, event: () => {}, error: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    { agentSources: sources },
  )
  t.after(() => session.stopAndWait())
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
})

test('受限权限不导入 AppAgent 顶层，也不注册外部工具', async (t) => {
  for (const mode of ['read-only', 'workspace-write'] as const) {
    await t.test(mode, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), `app-agent-${mode}-`))
      t.after(() => rm(root, { recursive: true, force: true }))
      const fake = await useFakeAgent(root)
      t.after(() => fake.dispose())
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
      t.after(() => session.stopAndWait())
      session.configureInlineExtensions([
        createAppAgent({ pluginId: 'restricted-app', generation: 1, path: entry }, async () => ({
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
      await assert.rejects(access(marker), { code: 'ENOENT' })
      assert.ok(
        !fake.provider.requests[0].tools.some(
          (tool: { function: { name: string } }) => tool.function.name === 'restricted_app_tool',
        ),
      )
    })
  }
})
