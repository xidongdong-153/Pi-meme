import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { PiSessionPool } from '../src/session-pool'

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待重试事件超时')
    await delay(15)
  }
}

for (const succeeds of [true, false]) {
  test(`真实 SDK 重试${succeeds ? '成功' : '耗尽'}时同步事件与会话快照`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-retry-progress-'))
    const agent = await useFakeAgent(directory, {
      reply: (_body, index) => (index > 1 && succeeds ? { text: '已经完成' } : { status: 503, text: 'network error' }),
    })
    await writeFile(
      path.join(agent.agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'fake',
        defaultModel: 'first',
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 200, provider: { maxRetries: 0 } },
      }),
    )
    const events: DesktopEvent[] = []
    const pool = new PiSessionPool(
      directory,
      {
        connection: () => {},
        event: (event) => events.push(event),
        error: () => {},
        sessionsChanged: () => {},
      },
      undefined,
      agent.runtimePaths,
      agent.credentials,
    )
    try {
      pool.start(directory)
      const key = pool.connection().sessionKey!
      await pool.prompt(key, '测试重试')
      await waitFor(() => events.some(({ event }) => event.type === 'auto_retry_start'))
      const waiting = await pool.snapshot()
      assert.equal(waiting.state.retry?.kind, 'model')
      assert.equal(waiting.state.retry?.attempt, 1)
      assert.equal(waiting.state.retry?.maxAttempts, 2)
      assert.ok((waiting.state.retry?.delayMs ?? 0) > 0)
      assert.match(waiting.state.retry?.errorMessage ?? '', /network error/)
      assert.equal(waiting.state.isStreaming, true)
      await waitFor(() => events.some(({ event }) => event.type === 'agent_settled'))
      const finished = await pool.snapshot()
      assert.equal(finished.state.retry, undefined)
      assert.equal(finished.state.isStreaming, false)
      const result = events.find(({ event }) => event.type === 'auto_retry_end')?.event
      assert.equal(result?.type === 'auto_retry_end' && result.success, succeeds)
      assert.equal(agent.provider.requests.length, succeeds ? 2 : 3)
      const reply = finished.messages.findLast((message) => message.role === 'assistant')
      assert.equal(reply?.role === 'assistant' && reply.stopReason, succeeds ? 'stop' : 'error')
    } finally {
      await pool.stopAndWait()
      await agent.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
