import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '../src/session-pool'
import { SdkSession } from '../src/sdk/session'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { thinkingLevels, type PiExtensionDialogRequest } from '@pi-meme/contracts/pi'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createTestSession, installProjectExtension, waitFor, savedSession } from './session-pool-fixture'

test('自定义模型无需映射即可保留全部思考档位，发送和恢复后仍保留最大档位', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-thinking-levels-'))
  const agent = await useFakeAgent(directory, {
    models: [
      { id: 'first', reasoning: true },
      { id: 'second', reasoning: false },
    ],
  })
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
    for (const id of ['first', 'second']) {
      await session.setModel({ provider: 'fake', id })
      assert.deepEqual(await session.getAvailableThinkingLevels(), thinkingLevels)
      for (const level of thinkingLevels) {
        await session.setThinkingLevel(level)
        assert.equal((await session.snapshot()).state.thinkingLevel, level)
      }
    }
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.setThinkingLevel('max')
    await session.prompt('检查最大思考档位')
    const deadline = Date.now() + 5000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('等待思考档位请求完成超时')
      await delay(10)
    }
    assert.equal((await session.snapshot()).state.thinkingLevel, 'max')
    assert.equal(agent.provider.requests.at(-1)?.reasoning_effort, 'high')
    const file = session.getActiveSession().sessionFile!
    assert.ok(file)
    await session.stopAndWait()
    session = createSession()
    session.start(directory, file)
    const restored = await session.snapshot()
    assert.equal(restored.state.thinkingLevel, 'max')
    assert.deepEqual(restored.thinkingLevels, thinkingLevels)
    assert.equal(restored.messages.at(-1)?.role, 'assistant')
  } finally {
    await session.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('内置工具定位和图片输出规则与用户 SYSTEM.md、主会话和子代理提示共存', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-tool-discovery-'))
  const agent = await useFakeAgent(directory)
  const systemFile = path.join(agent.agentDir, 'SYSTEM.md')
  const system = '用户自定义系统提示：只处理当前项目。'
  await writeFile(systemFile, system)
  try {
    for (const delegated of [false, true]) {
      const session = new SdkSession(
        directory,
        { connection: () => {}, event: () => {}, error: () => {} },
        agent.runtimePaths,
        agent.credentials,
      )
      try {
        if (delegated) await session.configureAgentTask('定位项目工具')
        session.start(directory)
        await session.snapshot()
        await session.setModel({ provider: 'fake', id: 'first' })
        await session.prompt('检查可用工具')
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
        assert.match(text, /command -v、PATH 和明确的安装位置/)
        assert.match(text, /不要因为工具缺失自动执行 find \/ 或遍历整个用户目录/)
        assert.match(text, /Image output in user-facing replies:/)
        assert.match(text, /!\[Brief description\]\(out\/screenshots\/example\.png\)/)
        assert.match(text, /relative to the current session working directory/)
        assert.match(text, /copy only the image needed for the reply into out\/screenshots\//)
        assert.match(text, /Verify that the file exists before referencing it/)
        assert.match(text, /Do not use file:\/\/ URLs, absolute filesystem paths, or temporary localhost URLs/)
        assert.match(text, /Do not list multiple path or markup variants/)
        assert.match(text, /Keep valid remote HTTP\(S\) image URLs unchanged/)
        assert.equal(text.includes('你是执行委派任务的子 Agent'), delegated)
        if (delegated) assert.match(text, /当前委派任务：定位项目工具/)
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

test('恢复时模型不可用保留原选择，重新选择前禁止发送', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pool-model-'))
  const agent = await useFakeAgent(directory, {
    models: [
      { id: 'first', name: '模型 first', reasoning: true },
      { id: 'second', name: '模型 second', reasoning: true },
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
    const file = await savedSession(agent, directory, 'saved')
    pool.prepare(directory)
    await pool.switchSession(file)
    const key = pool.connection().sessionKey!
    await pool.setModel(key, { provider: 'fake', id: 'removed' })
    await pool.idle(() => pool.reconnectModels(), true)
    const snapshot = await pool.snapshot()
    assert.equal(snapshot.state.modelSelectionRequired, true)
    assert.equal(snapshot.state.model?.id, 'removed')
    await assert.rejects(pool.prompt(key, '不应发送'), /先重新选择模型/)
    await pool.setModel(key, { provider: 'fake', id: 'second' })
    await pool.prompt(key, 'long-conversation')
    await waitFor(() => pool.getRuntimeSessions().every((session) => !session.running))
    assert.equal((await pool.snapshot()).state.model?.id, 'second')
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
