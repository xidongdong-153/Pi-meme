import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PiMessage } from '@pi-meme/contracts/pi'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import type { TaskMode } from '@pi-meme/contracts/plan'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { SdkSession, type RuntimePolicy } from '../src/sdk/session'
import { loadPiSdk } from '../src/sdk/load'

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待恢复事件超时')
    await delay(10)
  }
}

function failed(messages: PiMessage[]) {
  return messages.filter(
    (message): message is Extract<PiMessage, { role: 'assistant' }> =>
      message.role === 'assistant' && message.stopReason === 'error',
  )
}

async function fixture(
  reply: NonNullable<Parameters<typeof useFakeAgent>[1]>['reply'],
  run: (context: {
    directory: string
    session: SdkSession
    events: DesktopEvent['event'][]
    fake: Awaited<ReturnType<typeof useFakeAgent>>
  }) => Promise<void>,
  policy?: RuntimePolicy,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-recovery-'))
  const fake = await useFakeAgent(directory, { reply })
  await writeFile(
    path.join(fake.agentDir, 'settings.json'),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
  )
  const events: DesktopEvent['event'][] = []
  const session = new SdkSession(
    directory,
    { connection: () => {}, event: ({ event }) => events.push(event), error: () => {} },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    policy,
  )
  try {
    session.start(directory)
    await session.snapshot()
    await run({ directory, session, events, fake })
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

function settledCount(events: DesktopEvent['event'][]) {
  return events.filter((event) => event.type === 'agent_settled').length
}

test('真实 SDK 恢复保留工具结果、省略失败且不新增用户消息，重开后仍有效', async () => {
  await fixture(
    (_body, index) =>
      index === 1
        ? { text: '先读取文件', tool: { name: 'read', arguments: JSON.stringify({ path: 'result.txt' }) } }
        : index === 2
          ? { status: 503, text: 'network error' }
          : { text: '从已有结果继续完成', holdMs: 80 },
    async ({ directory, session, events, fake }) => {
      await writeFile(path.join(directory, 'result.txt'), '已经完成的工具结果')
      await session.prompt('读取文件后继续处理')
      await waitFor(() => settledCount(events) === 1)
      const before = await session.snapshot()
      assert.equal(failed(before.messages).length, 1)
      assert.ok(before.state.recovery)
      const { entryId } = before.state.recovery
      const ended = events.findLast((event) => event.type === 'agent_settled')
      assert.deepEqual(ended?.type === 'agent_settled' && ended.recovery, before.state.recovery)
      const tool = before.messages.find((message) => message.role === 'toolResult')
      assert.ok(tool)
      const done = before.messages.find((message) => message.role === 'assistant' && message.stopReason === 'toolUse')
      assert.ok(done)
      const recovering = session.recover(entryId)
      await assert.rejects(session.recover(entryId), /运行|切换|恢复/)
      await recovering
      await waitFor(() => settledCount(events) === 2)
      const after = await session.snapshot()
      assert.equal(failed(after.messages).length, 0)
      assert.equal(after.state.recovery, undefined)
      assert.equal(after.messages.filter((message) => message.role === 'user').length, 1)
      assert.deepEqual(
        after.messages.find((message) => message.role === 'toolResult'),
        tool,
      )
      assert.deepEqual(
        after.messages.find((message) => message.role === 'assistant' && message.stopReason === 'toolUse'),
        done,
      )
      assert.equal(fake.provider.requests.length, 3)
      assert.match(JSON.stringify(fake.provider.requests.at(-1)), /已经完成的工具结果/)
      assert.doesNotMatch(JSON.stringify(fake.provider.requests.at(-1)), /network error/)
      assert.equal(events.filter((event) => event.type === 'tool_execution_start').length, 1)
      assert.ok(events.some((event) => event.type === 'recovery_start'))
      await assert.rejects(session.recover(entryId), /失效|恢复/)
      const file = session.getActiveSession().sessionFile!
      const { SessionManager } = await loadPiSdk()
      const manager = SessionManager.open(file)
      assert.equal(failed(manager.buildSessionContext().messages).length, 0)
      assert.ok(
        manager
          .getEntries()
          .some((entry) => entry.type === 'context_edit' && entry.targetId === entryId && entry.replacement === null),
      )
      session.start(directory, file)
      const reopened = await session.snapshot()
      assert.equal(failed(reopened.messages).length, 0)
      assert.equal(reopened.messages.filter((message) => message.role === 'user').length, 1)
      assert.deepEqual(
        reopened.messages.find((message) => message.role === 'toolResult'),
        JSON.parse(JSON.stringify(tool)),
      )
      assert.equal(reopened.state.recovery, undefined)
    },
  )
})

test('SDK 恢复拒绝过期失败和暂停，失败重试只接受最新 entryId', async () => {
  await fixture({ status: 503, text: 'network error' }, async ({ session, events }) => {
    await session.prompt('第一次失败')
    await waitFor(() => settledCount(events) === 1)
    const original = (await session.snapshot()).state.recovery!
    assert.ok(original)
    await assert.rejects(session.recover('expired-entry'), /失效|恢复/)
    await session.pause()
    await assert.rejects(session.recover(original.entryId), /暂停/)
    await session.resume()
    await session.recover(original.entryId)
    await waitFor(() => settledCount(events) === 2)
    const again = await session.snapshot()
    assert.ok(again.state.recovery)
    assert.notEqual(again.state.recovery.entryId, original.entryId)
    assert.equal(failed(again.messages).length, 1)
    await assert.rejects(session.recover(original.entryId), /失效|恢复/)
  })
})

test('SDK 重新打开失败任务保留规划模式，恢复不覆盖当前模式选择', async () => {
  const modes: TaskMode[] = []
  await fixture(
    (_body, index) => (index === 1 ? { status: 503, text: 'network error' } : { text: '继续规划' }),
    async ({ directory, session, events }) => {
      await session.prompt('规划任务', undefined, [], { mode: 'plan' })
      await waitFor(() => settledCount(events) === 1)
      const failure = (await session.snapshot()).state.recovery!
      assert.equal(failure.mode, 'plan')
      const file = session.getActiveSession().sessionFile!
      session.start(directory, file)
      await session.snapshot()
      await session.setSessionMode('default')
      assert.deepEqual((await session.snapshot()).state.recovery, failure)
      await session.recover(failure.entryId)
      await waitFor(() => settledCount(events) === 2)
      const after = await session.snapshot()
      assert.equal(after.state.mode, 'default')
      assert.deepEqual(modes, ['plan', 'plan'])
    },
    {
      onAdmission: async (_message, mode) => {
        modes.push(mode)
      },
    },
  )
})

test('SDK 恢复预检或启动失败时保留原错误和可恢复入口', async () => {
  let rejectAdmission = false
  await fixture(
    (_body, index) => (index === 1 ? { status: 503, text: 'network error' } : { text: '恢复成功' }),
    async ({ session, events }) => {
      await session.prompt('原任务')
      await waitFor(() => settledCount(events) === 1)
      const before = await session.snapshot()
      const recovery = before.state.recovery!
      assert.ok(recovery)
      rejectAdmission = true
      await assert.rejects(session.recover(recovery.entryId), /拒绝预检/)
      assert.deepEqual((await session.snapshot()).state.recovery, recovery)
      assert.deepEqual(failed((await session.snapshot()).messages), failed(before.messages))
      rejectAdmission = false
      const { AgentSession } = await loadPiSdk()
      const refresh = vi.spyOn(AgentSession.prototype, 'refreshContext').mockImplementationOnce(() => {
        throw new Error('同步上下文失败')
      })
      try {
        await assert.rejects(session.recover(recovery.entryId), /同步上下文失败/)
      } finally {
        refresh.mockRestore()
      }
      assert.deepEqual((await session.snapshot()).state.recovery, recovery)
      assert.deepEqual(failed((await session.snapshot()).messages), failed(before.messages))
      const start = vi.spyOn(AgentSession.prototype, 'sendCustomMessage').mockRejectedValueOnce(new Error('启动失败'))
      try {
        await assert.rejects(session.recover(recovery.entryId), /启动失败/)
      } finally {
        start.mockRestore()
      }
      const restored = await session.snapshot()
      assert.deepEqual(restored.state.recovery, recovery)
      assert.deepEqual(failed(restored.messages), failed(before.messages))
      assert.equal(
        events.some((event) => event.type === 'recovery_start'),
        false,
      )
      await session.recover(recovery.entryId)
      await waitFor(() => settledCount(events) === 2)
      assert.equal(failed((await session.snapshot()).messages).length, 0)
    },
    {
      onAdmission: async () => {
        if (rejectAdmission) throw new Error('拒绝预检')
      },
    },
  )
})

test('SDK 恢复一次省略历史尾部连续失败，不回退原用户消息', async () => {
  await fixture(
    (_body, index) => (index === 1 ? { status: 503, text: 'network error' } : { text: '恢复成功' }),
    async ({ directory, session, events }) => {
      await session.prompt('原任务')
      await waitFor(() => settledCount(events) === 1)
      const before = await session.snapshot()
      const file = session.getActiveSession().sessionFile!
      await session.stopAndWait()
      const { SessionManager } = await loadPiSdk()
      const manager = SessionManager.open(file)
      const error = failed(before.messages)[0]!
      const latestId = manager.appendMessage({ ...error, timestamp: error.timestamp + 1 })
      session.start(directory, file)
      const consecutive = await session.snapshot()
      assert.equal(failed(consecutive.messages).length, 2)
      assert.equal(consecutive.state.recovery?.entryId, latestId)
      await session.recover(latestId)
      await waitFor(() => settledCount(events) === 2)
      const after = await session.snapshot()
      assert.equal(failed(after.messages).length, 0)
      assert.equal(after.messages.filter((message) => message.role === 'user').length, 1)
      const recovered = events.find((event) => event.type === 'recovery_start')
      assert.equal(recovered?.type === 'recovery_start' && recovered.removedMessageTimestamps.length, 2)
      assert.equal(failed(SessionManager.open(file).buildSessionContext().messages).length, 0)
    },
  )
})

test('SDK 自动重试耗尽后手动恢复，启动失败不会重新显示已省略的尝试', async () => {
  await fixture(
    (_body, index) => (index <= 3 ? { status: 503, text: 'network error' } : { text: '恢复成功' }),
    async ({ directory, session, events, fake }) => {
      await writeFile(
        path.join(fake.agentDir, 'settings.json'),
        JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } } }),
      )
      session.start(directory)
      await session.snapshot()
      await session.prompt('耗尽自动重试')
      await waitFor(() => settledCount(events) === 1)
      const before = await session.snapshot()
      const recovery = before.state.recovery!
      assert.ok(recovery)
      assert.equal(fake.provider.requests.length, 3)
      assert.equal(failed(before.messages).length, 1)
      const { AgentSession } = await loadPiSdk()
      const start = vi.spyOn(AgentSession.prototype, 'sendCustomMessage').mockRejectedValueOnce(new Error('启动失败'))
      try {
        await assert.rejects(session.recover(recovery.entryId), /启动失败/)
      } finally {
        start.mockRestore()
      }
      assert.deepEqual(failed((await session.snapshot()).messages), failed(before.messages))
      await session.recover(recovery.entryId)
      await waitFor(() => settledCount(events) === 2)
      assert.equal(fake.provider.requests.length, 4)
      assert.equal(failed((await session.snapshot()).messages).length, 0)
      const recovered = events.find((event) => event.type === 'recovery_start')
      assert.equal(recovered?.type === 'recovery_start' && recovered.removedMessageTimestamps.length, 3)
    },
  )
})

test('SDK 不把鉴权失败当成网络恢复', async () => {
  await fixture({ status: 401, text: 'invalid API key' }, async ({ session, events }) => {
    await session.prompt('鉴权失败')
    await waitFor(() => settledCount(events) === 1)
    assert.equal((await session.snapshot()).state.recovery, undefined)
    await assert.rejects(session.recover('anything'), /失效|恢复/)
  })
})
