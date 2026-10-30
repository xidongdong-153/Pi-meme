import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '../src/session-pool'
import { SdkSession } from '../src/sdk/session'
import { readSessionHistory } from '../src/session-history'
import { createDesktopModelRuntime, projectModel } from '../src/sdk/model-runtime'
import { loadPiSdk } from '../src/sdk/load'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { thinkingLevels, type PiExtensionDialogRequest } from '@pi-meme/contracts/pi'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import {
  appSessionFile,
  createTestSession,
  installProjectExtension,
  waitFor,
  savedSession,
} from './session-pool-fixture'

test('会话档位与模型能力一致，映射后的 max 在发送和恢复时保持一致', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-thinking-levels-'))
  const models = [
    { id: 'first', reasoning: true },
    { id: 'second', reasoning: false },
    { id: 'mapped', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', low: null } },
  ]
  const agent = await useFakeAgent(directory, { models })
  const createSession = () =>
    new SdkSession(
      directory,
      { connection: () => {}, event: () => {}, error: () => {} },
      agent.runtimePaths,
      agent.credentials,
    )
  let session = createSession()
  try {
    session.start(directory)
    await session.snapshot()
    for (const [id, levels, effective] of [
      ['first', ['off', 'minimal', 'low', 'medium', 'high'], 'high'],
      ['second', ['off'], 'off'],
      ['mapped', thinkingLevels.filter((level) => level !== 'low'), 'max'],
    ] as const) {
      await session.setModel({ provider: 'fake', id })
      assert.deepEqual(await session.getAvailableThinkingLevels(), levels)
      await session.setThinkingLevel('max')
      assert.equal((await session.snapshot()).state.thinkingLevel, effective)
    }
    await session.setThinkingLevel('low')
    assert.equal((await session.snapshot()).state.thinkingLevel, 'medium')
    await session.setThinkingLevel('max')
    await session.prompt('检查最大思考档位')
    const deadline = Date.now() + 5000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('等待思考档位请求完成超时')
      await delay(10)
    }
    assert.equal((await session.snapshot()).state.thinkingLevel, 'max')
    assert.equal(agent.provider.requests.at(-1)?.reasoning_effort, 'max')
    const file = session.getActiveSession().sessionFile!
    assert.ok(file)
    await session.stopAndWait()
    session = createSession()
    session.start(directory, file)
    const restored = await session.snapshot()
    assert.equal(restored.state.thinkingLevel, 'max')
    assert.deepEqual(
      restored.thinkingLevels,
      thinkingLevels.filter((level) => level !== 'low'),
    )
    assert.equal(restored.messages.at(-1)?.role, 'assistant')
    await session.stopAndWait()
    const config = JSON.parse(await readFile(agent.modelsFile, 'utf8'))
    delete config.providers.fake.models[2].thinkingLevelMap
    await writeFile(agent.modelsFile, JSON.stringify(config))
    session = createSession()
    session.start(directory, file)
    assert.equal((await session.snapshot()).state.thinkingLevel, 'high')
  } finally {
    await session.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('冷会话按各自模型提供档位，切换和启动后保留实际强度', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-cold-thinking-'))
  const agent = await useFakeAgent(directory, {
    models: [
      { id: 'first', reasoning: true },
      { id: 'second', reasoning: false },
    ],
  })
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    createTestSession,
  )
  try {
    pool.prepare(directory)
    const key = pool.connection().sessionKey!
    await pool.setModel(key, { provider: 'fake', id: 'first' })
    await pool.setThinkingLevel(key, 'max')
    assert.equal((await pool.snapshot()).state.thinkingLevel, 'high')
    assert.deepEqual(await pool.getAvailableThinkingLevels(), ['off', 'minimal', 'low', 'medium', 'high'])
    await pool.setModel(key, { provider: 'fake', id: 'second' })
    assert.equal((await pool.snapshot()).state.thinkingLevel, 'off')
    assert.deepEqual(await pool.getAvailableThinkingLevels(), ['off'])
    await pool.setModel(key, { provider: 'fake', id: 'first' })
    await pool.setThinkingLevel(key, 'max')
    await pool.prompt(key, '检查冷会话强度')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.equal((await pool.snapshot()).state.thinkingLevel, 'high')
    assert.equal(agent.provider.requests.at(-1)?.reasoning_effort, 'high')
    await pool.setThinkingLevel(key, 'max')
    assert.equal(pool.readSessionBinding(key).state.thinkingLevel, 'high')
    await pool.setModel(key, { provider: 'fake', id: 'second' })
    assert.equal(pool.readSessionBinding(key).state.thinkingLevel, 'off')
  } finally {
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('英文 App 区块与用户 SYSTEM.md、普通和 Plan 主子会话共存且各注入一次', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-tool-discovery-'))
  const agent = await useFakeAgent(directory)
  const systemFile = path.join(agent.agentDir, 'SYSTEM.md')
  const system = '用户自定义系统提示：只处理当前项目。'
  await writeFile(systemFile, system)
  try {
    for (const { delegated, mode } of [
      { delegated: false, mode: 'default' },
      { delegated: true, mode: 'default' },
      { delegated: false, mode: 'plan' },
      { delegated: true, mode: 'plan' },
    ] as const) {
      const session = new SdkSession(
        directory,
        { connection: () => {}, event: () => {}, error: () => {} },
        agent.runtimePaths,
        agent.credentials,
      )
      try {
        if (delegated) await session.configureAgentTask('定位项目工具')
        await session.setSessionMode(mode)
        session.start(directory)
        await session.snapshot()
        await session.setModel({ provider: 'fake', id: 'first' })
        await session.prompt('检查可用工具', undefined, [], { mode })
        const deadline = Date.now() + 5000
        while ((await session.snapshot()).state.isStreaming) {
          if (Date.now() > deadline) throw new Error('等待工具定位提示请求超时')
          await delay(10)
        }
        const request = agent.provider.requests.at(-1)!
        const text = request.messages
          .filter((message: { role: string }) => message.role === 'system' || message.role === 'developer')
          .map((message: { content: unknown }) => JSON.stringify(message.content))
          .join('\n')
        assert.match(text, /用户自定义系统提示/)
        assert.match(text, /command not found/)
        assert.match(text, /command -v, PATH, and known installation locations/)
        assert.match(text, /Do not conclude that the tool is uninstalled or search \/ or the entire home directory/)
        for (const section of ['app_runtime', 'app_output']) {
          assert.equal(text.split(`<${section}>`).length - 1, 1, section)
        }
        assert.match(text, /Preserve the user’s requested language/)
        assert.match(text, /unless the user requests an exact output format/)
        assert.match(text, /GFM tables/)
        assert.match(text, /KaTeX-compatible syntax/)
        assert.match(text, /fenced `mermaid` block/)
        assert.match(text, /File references are not guaranteed to open in an editor/)
        assert.match(text, /!\[Brief description\]\(out\/screenshots\/example\.png\)/)
        assert.match(text, /relative to the current session working directory/)
        assert.match(text, /Verify that the file exists/)
        assert.match(text, /up to 8 MiB/)
        assert.match(text, /仅在允许写入时将工作区外的图片复制到工作目录/)
        assert.match(text, /在规划或只读模式下，必要的展示产物放入会话临时目录/)
        assert.match(text, /不得绕过访问拒绝/)
        assert.match(text, /不要使用 file:\/\/、绝对路径、临时 localhost URL 或新建服务器展示本地图片/)
        assert.match(text, /除附件目录内已上传图片和 image_gen 产物外/)
        assert.match(text, /无需复制到工作目录或重复读取/)
        assert.match(text, /除非用户要求渲染测试，不要尝试多种标记变体/)
        assert.match(text, /Keep valid remote HTTP\(S\) image URLs unchanged/)
        assert.match(text, /cards are created by actual tool events, not reply markup/)
        assert.equal(text.includes('<app_delegation>'), delegated)
        if (delegated) {
          assert.equal(text.split('<app_delegation>').length - 1, 1)
          assert.match(text, /Current delegated task: 定位项目工具/)
          assert.match(text, /Inherited parent conversation is background context/)
        }
        if (mode === 'plan') {
          const planText = JSON.stringify(request.messages)
          assert.match(planText, /当前为规划模式，只进行检查和分析/)
          assert.match(planText, /命令行在只读沙箱内运行/)
          assert.match(planText, /禁止实施变更、修改业务文件/)
          const tools = request.tools.map((tool: { function: { name: string } }) => tool.function.name)
          for (const name of ['bash', 'codemode']) assert.ok(tools.includes(name), name)
          for (const name of ['edit', 'write', 'get_goal', 'update_goal']) assert.ok(!tools.includes(name), name)
        }
      } finally {
        await session.stopAndWait()
      }
    }
    assert.equal(await readFile(systemFile, 'utf8'), system)
  } finally {
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('权限切换保留实际执行代次，确认请求通过过期过滤且回答后正确关闭', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-dialog-generation-'))
  const agent = await useFakeAgent(directory)
  await installProjectExtension(directory)
  let session!: SdkSession
  let emit!: (event: DesktopEvent) => void
  let highestExecutionGeneration = 0
  const events: DesktopEvent[] = []
  const accepted: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: (event) => {
        events.push(event)
        const executionGeneration = event.executionGeneration ?? event.generation
        if (executionGeneration < highestExecutionGeneration) return
        highestExecutionGeneration = executionGeneration
        accepted.push(event)
      },
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      emit = notify.event
      session = createTestSession(cwd, notify, paths, credentials, mcp)
      return session
    },
  )
  const view = pool.createClientView()
  try {
    await pool.withClientView(view, async () => {
      pool.start(directory)
      await pool.snapshot()
      const key = pool.connection().sessionKey!
      view.generation = 40
      await pool.setAccessMode(key, 'full-access')
      const changed = events.find((event) => event.event.type === 'access_mode_changed')!
      assert.equal(changed.generation, 40)
      assert.equal(changed.executionGeneration, session.connection().generation)
      assert.ok(changed.executionGeneration! < changed.generation)
      const prompting = pool.prompt(key, '扩展任务')
      await waitFor(() => events.some((event) => event.event.type === 'extension_ui_request'))
      const dialog = accepted.find(
        (event): event is DesktopEvent & { event: PiExtensionDialogRequest } =>
          event.event.type === 'extension_ui_request' && event.event.method === 'confirm',
      )
      assert.ok(dialog, '确认请求不能被权限切换事件的界面代次误判为过期')
      assert.equal(dialog.executionGeneration, session.connection().generation)
      view.generation = 80
      await pool.respondExtensionUI(key, dialog.event.id, { confirmed: true })
      const closed = accepted.find(
        (event) => event.event.type === 'extension_ui_closed' && event.event.id === dialog.event.id,
      )!
      assert.equal(closed.generation, 80)
      assert.equal(closed.executionGeneration, dialog.executionGeneration)
      await prompting
      await waitFor(() => pool.getRuntimeSessions().every((record) => !record.running))
      assert.ok(!((await pool.snapshot()).events ?? []).some((event) => event.event.type === 'extension_ui_request'))
      const acceptedCount = accepted.length
      const staleGeneration = dialog.executionGeneration! - 1
      emit({ generation: staleGeneration, event: { type: 'extension_ui_closed', id: '旧请求', reason: 'cancelled' } })
      assert.equal(events.at(-1)?.executionGeneration, staleGeneration)
      assert.equal(accepted.length, acceptedCount)
    })
  } finally {
    await pool.stopAndWait()
    pool.releaseClientView(view)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史模型不可用时使用默认模型和思考强度，发送后保留实际选择', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-model-'))
  const models = [
    { id: 'first', name: '模型 first', reasoning: true },
    { id: 'second', name: '模型 second', reasoning: true, thinkingLevelMap: { low: null } },
  ]
  const agent = await useFakeAgent(directory, { models })
  await writeFile(
    path.join(agent.agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fake',
      defaultModel: 'second',
      defaultThinkingLevel: 'high',
      modelThinkingLevels: { 'fake/second': 'low' },
    }),
  )
  const errors: string[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: (value) => errors.push(value.message),
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    createTestSession,
  )
  try {
    const file = await savedSession(agent, directory, 'saved')
    const entries = (await readFile(file, 'utf8')).split('\n').map((line) => JSON.parse(line))
    entries[1].provider = 'removed-provider'
    entries[1].modelId = 'removed-model'
    entries[2].parentId = 'thinking'
    entries.splice(2, 0, {
      type: 'thinking_level_change',
      id: 'thinking',
      parentId: 'model',
      timestamp: '2026-09-29T00:00:00Z',
      thinkingLevel: 'high',
    })
    const original = entries.map((entry) => JSON.stringify(entry)).join('\n')
    await writeFile(file, original)
    const directFile = await appSessionFile(agent, directory, 'direct.jsonl')
    await writeFile(directFile, original)
    const direct = new SdkSession(
      directory,
      { connection: () => {}, event: () => {}, error: (value) => errors.push(value.message) },
      agent.runtimePaths,
      agent.credentials,
    )
    try {
      direct.start(directory, directFile)
      const restored = await direct.snapshot()
      assert.equal(restored.state.model?.id, 'second')
      assert.equal(restored.state.thinkingLevel, 'medium')
    } finally {
      await direct.stopAndWait()
    }
    pool.prepare(directory)
    const selection = await pool.switchSession(file)
    assert.equal(selection.cancelled, false)
    const key = pool.connection().sessionKey!
    const snapshot = await pool.snapshot()
    assert.equal(snapshot.state.modelSelectionRequired, false)
    assert.equal(snapshot.state.model?.id, 'second')
    assert.equal(snapshot.state.thinkingLevel, 'medium')
    assert.equal(await readFile(file, 'utf8'), original)
    await pool.prompt(key, 'long-conversation')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.equal((await pool.snapshot()).state.model?.id, 'second')
    assert.equal((await pool.snapshot()).state.thinkingLevel, 'medium')
    assert.equal(agent.provider.requests.at(-1)?.model, 'second')
    assert.equal(agent.provider.requests.at(-1)?.reasoning_effort, 'medium')
    const history = await readSessionHistory(file)
    assert.deepEqual(history.model, { provider: 'fake', id: 'second' })
    assert.equal(history.thinkingLevel, 'medium')
    assert.deepEqual(errors, [])
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史模型仍可用时保留原模型和思考强度', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-model-available-'))
  const agent = await useFakeAgent(directory, {
    models: [
      { id: 'first', reasoning: true },
      { id: 'second', reasoning: true },
    ],
  })
  await writeFile(
    path.join(agent.agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'second', defaultThinkingLevel: 'low' }),
  )
  const file = await savedSession(agent, directory, 'saved')
  const entries = (await readFile(file, 'utf8')).split('\n').map((line) => JSON.parse(line))
  entries[2].parentId = 'thinking'
  entries.splice(2, 0, {
    type: 'thinking_level_change',
    id: 'thinking',
    parentId: 'model',
    timestamp: '2026-09-29T00:00:00Z',
    thinkingLevel: 'high',
  })
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n'))
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    createTestSession,
  )
  try {
    pool.prepare(directory)
    await pool.switchSession(file)
    const snapshot = await pool.snapshot()
    assert.equal(snapshot.state.model?.id, 'first')
    assert.equal(snapshot.state.thinkingLevel, 'high')
    await pool.prompt(pool.connection().sessionKey!, '继续旧会话')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.equal(agent.provider.requests.at(-1)?.model, 'first')
    assert.equal(agent.provider.requests.at(-1)?.reasoning_effort, 'high')
  } finally {
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史模型和默认模型均不可用时选择其他可用模型；没有可用模型时保留待选择状态', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-model-fallback-'))
  const agent = await useFakeAgent(directory, { models: [{ id: 'first', reasoning: false }] })
  await writeFile(
    path.join(agent.agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'removed', defaultModel: 'removed', defaultThinkingLevel: 'high' }),
  )
  const file = await savedSession(agent, directory, 'saved')
  const entries = (await readFile(file, 'utf8')).split('\n').map((line) => JSON.parse(line))
  entries[1].provider = 'removed'
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n'))
  const createPool = () =>
    new PiSessionPool(
      directory,
      { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
      undefined,
      agent.runtimePaths,
      agent.credentials,
      createTestSession,
    )
  let pool = createPool()
  try {
    pool.prepare(directory)
    await pool.switchSession(file)
    let snapshot = await pool.snapshot()
    assert.equal(snapshot.state.model?.id, 'first')
    assert.equal(snapshot.state.thinkingLevel, 'off')
    assert.equal(snapshot.state.modelSelectionRequired, false)
    await pool.stopAndWait()

    agent.credentials.delete('model-provider:fake')
    pool = createPool()
    pool.prepare(directory)
    await pool.switchSession(file)
    snapshot = await pool.snapshot()
    assert.equal(snapshot.state.model?.provider, 'removed')
    assert.equal(snapshot.state.modelSelectionRequired, true)
    assert.deepEqual(snapshot.models, [])
  } finally {
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Responses 请求按显式映射发送 max，未声明时回落 high', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-responses-thinking-'))
  const agent = await useFakeAgent(directory, {
    providers: {
      fake: {
        api: 'openai-responses',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'test',
        models: [
          { id: 'plain', reasoning: true },
          { id: 'mapped', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
        ],
      },
    },
  })
  try {
    const runtime = await createDesktopModelRuntime(await loadPiSdk(), agent.agentDir, agent.credentials)
    for (const [id, effort] of [
      ['plain', 'high'],
      ['mapped', 'max'],
    ]) {
      const model = runtime.getModel('fake', id)!
      assert.equal(projectModel(model).thinkingLevels?.includes('max'), id === 'mapped')
      let payload: unknown
      const reply = await runtime.completeSimple(
        model,
        { messages: [] },
        {
          reasoning: 'max',
          onPayload: (value) => {
            payload = value
            throw new Error('测试已捕获请求体，停止发送')
          },
        },
      )
      assert.match(reply.errorMessage ?? '', /测试已捕获请求体/)
      assert.equal((payload as { reasoning: { effort: string } }).reasoning.effort, effort)
    }
  } finally {
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
