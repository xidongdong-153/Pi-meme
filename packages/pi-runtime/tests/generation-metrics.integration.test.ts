import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { PiSessionPool } from '../src/session-pool'
import { waitFor } from './session-pool-fixture'

test('真实 SDK 的生成指标流经会话池，完成后校准用量，切换会话后分别恢复', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-generation-metrics-'))
  let release!: () => void
  const finishBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const agent = await useFakeAgent(directory, {
    reply: { text: '用于校准实时输出 token 的测试内容。'.repeat(4), delayMs: 100, finishBarrier },
  })
  const events: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    { connection: () => {}, event: (event) => events.push(event), error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  try {
    pool.start(directory)
    assert.equal((await pool.snapshot()).state.generationMetrics, undefined)
    const key = pool.connection().sessionKey!
    await pool.prompt(key, '测量生成速率')
    await waitFor(() => events.some(({ event }) => 'generationMetrics' in event && event.generationMetrics?.estimated))
    const streaming = (await pool.snapshot()).state.generationMetrics!
    assert.equal(streaming.running, true)
    assert.equal(streaming.estimated, true)
    assert.ok(streaming.outputTokens > 0)
    assert.ok(streaming.ttftMs! >= 0)
    const sessionFile = pool.getActiveSession().sessionFile!
    release()
    await waitFor(() => events.some(({ event }) => event.type === 'agent_settled'))
    const completed = (await pool.snapshot()).state.generationMetrics!
    assert.equal(completed.running, false)
    assert.equal(completed.estimated, false)
    assert.equal(completed.outputTokens, 4)
    assert.ok(completed.generationMs >= completed.ttftMs!)
    await pool.newSession()
    assert.equal((await pool.snapshot()).state.generationMetrics, undefined)
    await pool.switchSession(sessionFile)
    assert.deepEqual((await pool.snapshot()).state.generationMetrics, completed)
  } finally {
    release()
    await pool.stopAndWait()
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
