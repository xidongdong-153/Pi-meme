import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkerSession } from '../src/worker-session'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

test('Worker使用稳定SDK懒启动会话，停止后可重新创建运行时', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-worker-test-'))
  const paths = createPiRuntimePaths(root)
  await mkdir(paths.agentDir, { recursive: true })
  const session = createWorkerSession(root, { connection: () => {}, event: () => {}, error: () => {} }, paths, () => ({
    dataRoot: root,
    credentials: new MemoryCredentialStorage(),
    settings: { themeId: 'dark' },
    agentEntries: [],
  }))
  try {
    assert.equal(session.connection().status, 'disconnected')
    session.configureAccess('full-access')
    await session.reconnectModels()
    const snapshot = await session.snapshot()
    assert.equal(snapshot.connection.status, 'ready')
    assert.equal(snapshot.messages.length, 0)
    assert.equal(snapshot.connection.piVersion, '1.1.0')
    await session.stopAndWait()
    assert.equal(session.connection().status, 'disconnected')
    await session.reconnectModels()
    assert.equal((await session.snapshot()).connection.status, 'ready')
  } finally {
    await session.stopAndWait()
    await rm(root, { recursive: true, force: true })
  }
})

test('异步资源和租约只初始化一次；停止等待索引时取消启动并释放取得的租约', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-worker-resource-await-'))
  let resolveOptions!: (value: {
    dataRoot: string
    credentials: MemoryCredentialStorage
    settings: { themeId: string }
    agentEntries: []
    release: () => void
  }) => void
  let optionsCalls = 0
  let releases = 0
  const options = new Promise<Parameters<typeof resolveOptions>[0]>((resolve) => {
    resolveOptions = resolve
  })
  const session = createWorkerSession(
    root,
    { connection: () => {}, event: () => {}, error: () => {} },
    createPiRuntimePaths(root),
    async () => {
      optionsCalls++
      return options
    },
  )
  try {
    const first = session.snapshot()
    const second = session.getCommands()
    await delay(1)
    assert.equal(optionsCalls, 1)
    const stopped = session.stopAndWait()
    resolveOptions({
      dataRoot: root,
      credentials: new MemoryCredentialStorage(),
      settings: { themeId: 'dark' },
      agentEntries: [],
      release: () => {
        releases++
      },
    })
    await Promise.all([assert.rejects(first, /启动已取消/), assert.rejects(second, /启动已取消/), stopped])
    assert.equal(optionsCalls, 1)
    assert.equal(releases, 1)
    assert.equal(session.connection().status, 'disconnected')
  } finally {
    await session.stopAndWait()
    await rm(root, { recursive: true, force: true })
  }
})

test('仓库外 AppAgent 通过 App 接口加载，缺权限能力时受限执行拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-native-plugin-test-'))
  const paths = createPiRuntimePaths(root)
  const entry = path.join(root, 'external', 'entry.js')
  await mkdir(path.dirname(entry), { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    entry,
    `export function activate(ctx) { ctx.commands.register({name:'external-worker', description:'外部插件命令', execute:async()=>{}}) }\n`,
  )
  const session = createWorkerSession(root, { connection: () => {}, event: () => {}, error: () => {} }, paths, () => ({
    dataRoot: root,
    credentials: new MemoryCredentialStorage(),
    settings: { themeId: 'dark' },
    agentEntries: [{ pluginId: 'external-agent', generation: 1, path: entry }],
  }))
  try {
    session.configureAccess('full-access')
    await session.reconnectModels()
    assert.ok((await session.getCommands()).some((command) => command.name === 'external-worker'))
    await session.stopAndWait()
    session.configureAccess('workspace-write')
    await assert.rejects(session.reconnectModels(), /权限|沙箱/)
  } finally {
    await session.stopAndWait()
    await rm(root, { recursive: true, force: true })
  }
})

test('Worker重建模型后退出重开，真实弹窗事件与快照使用递增执行代次', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-worker-generation-'))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'generation-dialog', arguments: '{}' } } : '交互完成'),
  })
  const workerPath = path.join(root, 'interaction-worker.ts')
  const entry = path.join(root, 'generation-extension.js')
  const events: DesktopEvent[] = []
  const connections: number[] = []
  await writeFile(
    workerPath,
    `import { runSessionWorker } from ${JSON.stringify(fileURLToPath(new URL('../src/session-worker.ts', import.meta.url)))}
runSessionWorker({ interaction: (context) => { context.registerInteractionPolicy(true); return [] } })`,
  )
  await writeFile(
    entry,
    `export function activate(ctx) {ctx.tools.register({name:'generation-dialog',title:'确认',description:'验证Worker重开后的交互',parameters:{type:'object',properties:{}},execute:async(_params,execution)=>({text:JSON.stringify(await ctx.interaction.request([{id:'continue',question:'确认继续'}],execution.signal))})})}`,
  )
  const session = createWorkerSession(
    root,
    {
      connection: (value) => connections.push(value.generation),
      event: (value) => events.push(value),
      error: () => {},
    },
    fake.runtimePaths,
    () => ({
      dataRoot: path.dirname(fake.agentDir),
      credentials: fake.credentials,
      settings: { themeId: 'dark' },
      agentEntries: [{ pluginId: 'generation-test', generation: 1, path: entry }],
      workerPath,
    }),
  )
  try {
    await session.reconnectModels()
    const first = (await session.snapshot()).connection.generation
    await session.reconnectModels()
    const second = (await session.snapshot()).connection.generation
    assert.ok(second > first)
    await session.stopAndWait()
    await session.reconnectModels()
    const reopened = (await session.snapshot()).connection.generation
    assert.ok(reopened > second, `Worker执行代次不能从${second}回退到${reopened}`)
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('请求原生确认')
    const deadline = Date.now() + 5000
    while (!events.some((value) => value.event.type === 'extension_ui_request' && value.event.method === 'questions')) {
      if (Date.now() > deadline) throw new Error('Worker重开后未发出弹窗')
      await delay(10)
    }
    const event = events.find(
      (value) => value.event.type === 'extension_ui_request' && value.event.method === 'questions',
    )!
    assert.equal(event.generation, reopened)
    assert.equal((await session.snapshot()).connection.generation, reopened)
    assert.ok(connections.every((value, index) => !index || value >= connections[index - 1]!))
    assert.ok(event.event.type === 'extension_ui_request')
    await session.respondExtensionUI(event.event.id, { answers: [{ id: 'continue', value: 'true' }] })
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('Worker重开后的交互未完成')
      await delay(10)
    }
    const result = (await session.snapshot()).messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'generation-dialog',
    )
    assert.ok(result?.role === 'toolResult' && !result.isError)
    assert.match(JSON.stringify(result.content), /true/)
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('冷 Worker 暂停和释放编辑不启动运行时，启动继承最新门闸且停止清除缓存', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-worker-pause-'))
  const paths = createPiRuntimePaths(root)
  let acquired = 0
  const session = createWorkerSession(root, { connection: () => {}, event: () => {}, error: () => {} }, paths, () => {
    acquired++
    return {
      dataRoot: root,
      credentials: new MemoryCredentialStorage(),
      settings: { themeId: 'dark' },
      agentEntries: [],
    }
  })
  try {
    await session.setPaused(true, 3)
    await session.setPaused(false, 2)
    await session.releaseQueueEdits('client')
    assert.equal(acquired, 0)
    assert.equal(session.connection().status, 'disconnected')
    session.start(root)
    await session.snapshot()
    assert.equal(acquired, 1)
    assert.equal((await session.snapshot()).state.isPaused, true)
    await session.abort()
    assert.equal((await session.snapshot()).state.isPaused, false)
    await session.stopAndWait()
    await session.setPaused(true, 4)
    assert.equal(acquired, 1)
    await session.stopAndWait()
    session.start(root)
    await session.snapshot()
    assert.equal(acquired, 2)
    assert.equal((await session.snapshot()).state.isPaused, false)
  } finally {
    await session.stopAndWait()
    await rm(root, { recursive: true, force: true })
  }
})
