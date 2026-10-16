import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '../src/session-pool'
import type { SdkSession } from '../src/sdk/session'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import type { PiExtensionDialogRequest } from '@pi-meme/contracts/pi'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createTestSession, installProjectExtension, waitFor, savedSession } from './session-pool-fixture'

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
