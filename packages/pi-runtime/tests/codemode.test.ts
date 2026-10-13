import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import { SdkSession } from '../src/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function waitIdle(session: SdkSession) {
  const deadline = Date.now() + 10_000
  while ((await session.snapshot()).state.isStreaming) {
    if (Date.now() > deadline) throw new Error('codemode测试任务未完成')
    await delay(10)
  }
}

test('旧codemode开关不影响默认内置能力，嵌套读写仍遵守实际访问权限', async (t) => {
  for (const access of ['full-access', 'read-only', 'workspace-write'] satisfies AgentAccessMode[]) {
    await t.test(access, async (t) => {
      if (access !== 'full-access' && !['darwin', 'linux'].includes(process.platform))
        return t.skip('当前平台没有受支持的沙箱后端')
      const directory = await mkdtemp(path.join(tmpdir(), 'pi-codemode-'))
      const outside = await mkdtemp(path.join(tmpdir(), 'pi-codemode-outside-'))
      const project = path.join(directory, 'project')
      await mkdir(project)
      const source = path.join(project, 'source.txt')
      const insideTarget = path.join(project, 'inside.txt')
      const outsideTarget = path.join(outside, 'outside.txt')
      const code = `text(await tools.read({path:${JSON.stringify(source)}}));
text(JSON.stringify((await Promise.allSettled([
  tools.write({path:${JSON.stringify(insideTarget)},content:'inside'}),
  tools.write({path:${JSON.stringify(outsideTarget)},content:'outside'})
])).map(result => result.status === 'rejected' ? {status:result.status,error:result.reason.message} : {status:result.status})));`
      const fake = await useFakeAgent(directory, {
        reply: (_body, index) =>
          index === 1 ? { tool: { name: 'codemode', arguments: JSON.stringify({ code }) } } : '已检查权限',
      })
      const session = new SdkSession(
        project,
        { connection: () => {}, error: () => {}, event: () => {} },
        fake.runtimePaths,
        fake.credentials,
      )
      session.configureCapabilities({ codemodeEnabled: false, mcpEnabled: false })
      session.configureAccess(access)
      try {
        await writeFile(source, '可读取的文件')
        session.start(project)
        await session.snapshot()
        await session.setModel({ provider: 'fake', id: 'first' })
        await session.prompt('执行工具组合')
        await waitIdle(session)
        const tools = fake.provider.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name)
        assert.equal(tools.filter((name: string) => name === 'codemode').length, 1)
        const result = (await session.snapshot()).messages.find(
          (message) => message.role === 'toolResult' && message.toolName === 'codemode',
        )
        assert.ok(result?.role === 'toolResult' && !result.isError)
        assert.match(JSON.stringify(result.content), /可读取的文件/)
        if (access === 'read-only') {
          await assert.rejects(readFile(insideTarget), /ENOENT/)
          assert.match(JSON.stringify(result.content), /当前权限禁止修改本地文件/)
        } else assert.equal(await readFile(insideTarget, 'utf8'), 'inside')
        if (access === 'full-access') assert.equal(await readFile(outsideTarget, 'utf8'), 'outside')
        else await assert.rejects(readFile(outsideTarget), /ENOENT/)
      } finally {
        await session.stopAndWait()
        await fake.dispose()
        await rm(directory, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    })
  }
})

test('已由静态内置工厂提供codemode时，通用SDK不重复注册或覆盖工具', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-codemode-inline-'))
  const fake = await useFakeAgent(directory, {
    reply: (_body, index) =>
      index % 2 === 1 ? { tool: { name: 'codemode', arguments: '{"code":"text(123)"}' } } : '完成',
  })
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  let registered = 0
  session.configureInlineExtensions([
    {
      name: 'pi-meme-codemode',
      factory: (pi) => {
        registered += 1
        pi.registerTool({
          name: 'codemode',
          label: '内置代码工具',
          description: '验证静态工厂不会被重复注册覆盖',
          parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } as never,
          execute: async () => ({ content: [{ type: 'text', text: '静态内置工厂执行' }], details: {} }),
        })
      },
    },
  ])
  try {
    session.configureCapabilities({ codemodeEnabled: true, mcpEnabled: false })
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('使用内置工具')
    await waitIdle(session)
    session.configureCapabilities({ codemodeEnabled: false, mcpEnabled: false })
    await session.prompt('旧设置保存后仍使用内置工具')
    await waitIdle(session)
    const results = (await session.snapshot()).messages.filter(
      (message) => message.role === 'toolResult' && message.toolName === 'codemode',
    )
    assert.equal(results.length, 2)
    for (const result of results) {
      assert.ok(result.role === 'toolResult')
      assert.match(JSON.stringify(result.content), /静态内置工厂执行/)
    }
    assert.equal(registered, 1)
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Plan不装配codemode，即使模型强行调用也不能执行嵌套写入', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-codemode-plan-'))
  const target = path.join(directory, 'forbidden.txt')
  const fake = await useFakeAgent(directory, {
    reply: (_body, index) =>
      index === 1
        ? {
            tool: {
              name: 'codemode',
              arguments: JSON.stringify({ code: `await tools.write({path:${JSON.stringify(target)},content:'写入'})` }),
            },
          }
        : '计划完成',
  })
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  session.configureCapabilities({ codemodeEnabled: true, mcpEnabled: true })
  try {
    await session.setSessionMode('plan')
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('分析执行步骤')
    await waitIdle(session)
    const names = fake.provider.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name)
    for (const name of ['codemode', 'bash', 'write', 'edit', 'mcp__read']) assert.ok(!names.includes(name))
    const result = (await session.snapshot()).messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'codemode',
    )
    assert.ok(result?.role === 'toolResult' && result.isError)
    await assert.rejects(readFile(target), /ENOENT/)
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Plan实际执行链同样阻断协作工具中的嵌套codemode、MCP、shell、写入和第三方工具', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-codemode-plan-nested-'))
  const forbidden = ['codemode', 'mcp__read', 'bash', 'write', 'external']
  const fake = await useFakeAgent(directory, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'wait_agent', arguments: '{}' } } : '只读检查完成'),
  })
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
    fake.runtimePaths,
    fake.credentials,
  )
  let executed = 0
  session.configureInlineExtensions([
    {
      name: 'pi-meme-collaboration',
      factory: (pi) => {
        for (const name of forbidden)
          pi.registerTool({
            name,
            label: name,
            description: '验证嵌套执行仍检查Plan权限',
            exposure: 'deferred',
            parameters: { type: 'object', properties: {} } as never,
            execute: async () => {
              executed += 1
              return { content: [{ type: 'text', text: '不应执行' }], details: {} }
            },
          })
        pi.registerTool({
          name: 'wait_agent',
          label: '等待子任务',
          description: '验证协作工具的嵌套权限',
          parameters: { type: 'object', properties: {} } as never,
          execute: async (_id, _args, _signal, _onUpdate, ctx) => ({
            content: [
              {
                type: 'text',
                text: JSON.stringify(await Promise.all(forbidden.map((name) => ctx.executeTool(name, {})))),
              },
            ],
            details: {},
          }),
        })
      },
    },
  ])
  try {
    await session.setSessionMode('plan')
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('验证只读执行链')
    await waitIdle(session)
    const result = (await session.snapshot()).messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'wait_agent',
    )
    assert.ok(result?.role === 'toolResult')
    for (const name of forbidden)
      assert.match(JSON.stringify(result.content), new RegExp(`规划模式不能执行工具：${name}`))
    assert.equal(executed, 0)
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
