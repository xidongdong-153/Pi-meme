import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHost } from '../src/service'
import { finishAgentReply, useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

type Reply = NonNullable<Parameters<typeof useFakeAgent>[1]>['reply']
const key = (idempotencyKey: string) => ({ idempotencyKey })
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const deadline = Date.now() + 15000
  let value = await read()
  while (!check(value)) {
    if (Date.now() >= deadline) throw new Error(`目标等待超时：${JSON.stringify(value)}`)
    await delay(15)
    value = await read()
  }
  return value
}
async function fixture(reply: Reply) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-goal-host-')))
  const fake = await useFakeAgent(root, { reply, models: [{ id: 'first', input: ['text', 'image'] }] })
  const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  const cwd = path.join(root, 'project')
  await mkdir(cwd)
  const project = await host.app.projects.register({ cwd }, key('project'))
  const session = await host.app.sessions.create(
    { project, configuration: { model: { provider: 'fake', id: 'first' }, accessMode: 'full-access' } },
    key('session'),
  )
  return {
    root,
    host,
    fake,
    session,
    dispose: async () => {
      await host.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('Goal 多轮自动续跑至完成，首轮提交幂等，隐藏内部续跑并核算用量', { timeout: 25000 }, async () => {
  const f = await fixture((_body, index) =>
    index === 1
      ? '已经核对当前文件，下一轮继续验收。'
      : index === 2
        ? {
            tool: {
              name: 'update_goal',
              arguments: JSON.stringify({
                status: 'complete',
                summary: '所有要求已验收',
                evidence: ['本地假模型验收完成'],
              }),
            },
          }
        : '目标已完成。',
  )
  try {
    const input = { objective: '完整执行并逐项验收' }
    const started = await f.host.app.goals.start(f.session, input, key('start'))
    const replay = await f.host.app.goals.start(f.session, input, key('start'))
    assert.equal(replay.goal.goalId, started.goal.goalId)
    const goal = await eventually(
      () => f.host.app.goals.get(f.session),
      (goal) => goal?.status === 'complete' && goal.tokensUsed >= 48,
    )
    assert.equal(goal?.turns, 2)
    const snapshot = await eventually(
      () => f.host.app.sessions.snapshot(f.session),
      (snapshot) => !snapshot.state.isStreaming,
    )
    assert.equal(snapshot.goal?.status, 'complete')
    assert.equal(snapshot.messages.filter((message) => message.role === 'user').length, 1)
    assert.equal(f.fake.provider.sideRequests.length, 0)
    const events = await f.host.app.events.read({ sessionId: f.session.sessionId })
    assert.ok(JSON.stringify(events).includes('goal_updated'))
  } finally {
    await f.dispose()
  }
})

test('暂停、编辑、Plan 切换与清除不会恢复旧目标', { timeout: 25000 }, async () => {
  const f = await fixture({ text: '正在执行', holdMs: 250 })
  try {
    await f.host.app.goals.start(f.session, { objective: '原始目标' }, key('start'))
    await eventually(
      () => Promise.resolve(f.fake.provider.requests.length),
      (count) => count > 0,
    )
    const paused = await f.host.app.goals.pause(f.session, (await f.host.app.goals.get(f.session))!, key('pause'))
    assert.equal(paused.status, 'paused')
    const count = f.fake.provider.requests.length
    const edited = await f.host.app.goals.edit(f.session, { ...paused, objective: '修改后的目标' }, key('edit'))
    await f.host.app.sessions.configure(f.session, { mode: 'plan' }, key('plan'))
    await delay(80)
    assert.equal(f.fake.provider.requests.length, count)
    assert.equal((await f.host.app.goals.get(f.session))?.objective, '修改后的目标')
    await f.host.app.goals.clear(f.session, edited, key('clear'))
    assert.equal(await f.host.app.goals.get(f.session), undefined)
  } finally {
    await f.dispose()
  }
})

test('Host 重启只恢复目标状态与用量，不自动调用模型', { timeout: 25000 }, async () => {
  const f = await fixture({ text: '仍在执行', holdMs: 300 })
  let restored: Awaited<ReturnType<typeof createHost>> | undefined
  try {
    await f.host.app.goals.start(f.session, { objective: '重启恢复目标' }, key('start'))
    await eventually(
      () => Promise.resolve(f.fake.provider.requests.length),
      (count) => count > 0,
    )
    await f.host.dispose()
    const count = f.fake.provider.requests.length
    restored = await createHost({ dataRoot: f.fake.runtimePaths.dataRoot, credentials: f.fake.credentials })
    const goal = await restored.app.goals.get(f.session)
    assert.equal(goal?.status, 'paused')
    assert.equal(goal?.objective, '重启恢复目标')
    await delay(80)
    assert.equal(f.fake.provider.requests.length, count)
    assert.ok((await readFile(path.join(f.fake.runtimePaths.dataRoot, 'goals.json'), 'utf8')).includes('重启恢复目标'))
  } finally {
    await restored?.dispose()
    await f.dispose()
  }
})

test('三个空转轮次自动受阻，重复收尾事件不会多启动任务', { timeout: 25000 }, async () => {
  const f = await fixture('稍后继续。')
  try {
    await f.host.app.goals.start(f.session, { objective: '不能只复述状态' }, key('start'))
    const goal = (await eventually(
      () => f.host.app.goals.get(f.session),
      (goal) => goal?.status === 'blocked',
    ))!
    const snapshot = await f.host.app.sessions.snapshot(f.session)
    for (let i = 0; i < 3; i++)
      f.host.pi.publishSessionEvent(snapshot.connection.sessionKey!, {
        generation: 0,
        event: { type: 'agent_settled' },
      })
    await delay(60)
    assert.equal(goal.turns, 3)
    assert.equal(f.fake.provider.requests.length, 3)
    assert.equal(goal.tokensUsed, 48)
  } finally {
    await f.dispose()
  }
})

test('用户排队输入优先于 Goal 自动续跑，目标仍绑定原会话', { timeout: 25000 }, async () => {
  const f = await fixture((body, index) => {
    if (index === 1) return { text: '第一轮正在结束', holdMs: 200 }
    if (index === 2) {
      assert.ok(requestText(body).includes('用户补充验收条件'))
      return {
        tool: {
          name: 'update_goal',
          arguments: JSON.stringify({
            status: 'complete',
            summary: '已处理排队要求',
            evidence: ['补充条件已出现在当前请求'],
          }),
        },
      }
    }
    return '已完成。'
  })
  try {
    const other = await f.host.app.sessions.create({ project: f.session.project }, key('other'))
    await f.host.app.goals.start(f.session, { objective: '原会话目标' }, key('start'))
    await eventually(
      () => Promise.resolve(f.fake.provider.requests.length),
      (count) => count === 1,
    )
    const queued = await f.host.app.sessions.submit(
      f.session,
      { delivery: 'queue', text: '用户补充验收条件' },
      key('queued'),
    )
    await f.host.app.sessions.snapshot(other)
    await eventually(
      () => f.host.app.goals.get(f.session),
      (goal) => goal?.status === 'complete',
    )
    assert.equal((await f.host.app.goals.get(f.session))?.turns, 2)
    assert.equal(
      (
        await eventually(
          () => f.host.app.sessions.receipt(queued.operationId),
          (receipt) => receipt.status === 'completed',
        )
      ).status,
      'completed',
    )
    assert.equal((await f.host.app.sessions.snapshot(other)).messages.length, 0)
    assert.equal(await f.host.app.goals.get(other), undefined)
  } finally {
    await f.dispose()
  }
})

test('子代理用量归属根目标，子代理不能修改根目标，协作返回后完成', { timeout: 25000 }, async () => {
  const f = await fixture((body) => {
    const calls = (body.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>)
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function.name)
    const child = requestText(body).includes('你是执行委派任务的子 Agent')
    if (child)
      return calls.includes('update_goal')
        ? finishAgentReply(body, '子任务已核对，不能替父任务结束目标。')
        : {
            tool: {
              name: 'update_goal',
              arguments: JSON.stringify({
                status: 'complete',
                summary: '子任务尝试修改根目标',
                evidence: ['不应允许'],
              }),
            },
          }
    if (!calls.includes('spawn_agent'))
      return {
        tool: {
          name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'verify', message: '检查 GOAL_CHILD', fork_turns: 'none' }),
        },
      }
    if (!calls.includes('wait_agent'))
      return { tool: { name: 'wait_agent', arguments: JSON.stringify({ targets: ['verify'], timeout_ms: 1000 }) } }
    if (!calls.includes('update_goal'))
      return {
        tool: {
          name: 'update_goal',
          arguments: JSON.stringify({
            status: 'complete',
            summary: '已核对并读取子任务结果',
            evidence: ['子任务已结束且结果已读取'],
          }),
        },
      }
    return '目标已完成。'
  })
  try {
    await f.host.app.goals.start(f.session, { objective: '使用子任务核对目标' }, key('start'))
    const goal = (await eventually(
      () => f.host.app.goals.get(f.session),
      (goal) => goal?.status === 'complete',
    ))!
    await eventually(
      () => f.host.app.sessions.snapshot(f.session),
      (snapshot) => !snapshot.state.isStreaming,
    )
    const agents = await f.host.app.agents.list(f.session)
    const child = agents.find((agent) => agent.depth === 1)!
    assert.ok(child)
    const snapshot = await f.host.app.agents.get(child.agentId)
    assert.ok(
      snapshot.messages.some(
        (message) => message.role === 'toolResult' && message.isError && JSON.stringify(message).includes('子代理不能'),
      ),
    )
    assert.ok(goal.tokensUsed >= 80)
    const final = (await f.host.app.goals.get(f.session))!
    assert.equal(final.tokensUsed, f.fake.provider.requests.length * 16)
  } finally {
    await f.dispose()
  }
})

test('进入 Plan 暂停活跃目标，退出 Plan 保持暂停；控制参数和 Host 身份校验', { timeout: 25000 }, async () => {
  const f = await fixture({ text: '仍在执行', holdMs: 200 })
  try {
    const pure = await f.host.app.sessions.submit(f.session, { delivery: 'start', text: '/目标' }, key('pure'))
    assert.equal(pure.status, 'completed')
    assert.equal(await f.host.app.goals.get(f.session), undefined)
    assert.equal(f.fake.provider.requests.length, 0)
    await f.host.app.goals.start(f.session, { objective: '暂停再规划' }, key('start'))
    await eventually(
      () => Promise.resolve(f.fake.provider.requests.length),
      (count) => count > 0,
    )
    await f.host.app.sessions.configure(f.session, { mode: 'plan' }, key('plan'))
    assert.equal((await f.host.app.goals.get(f.session))?.status, 'paused')
    await f.host.app.sessions.configure(f.session, { mode: 'default' }, key('default'))
    const count = f.fake.provider.requests.length
    await delay(60)
    assert.equal(f.fake.provider.requests.length, count)
    await assert.rejects(f.host.app.goals.pause(f.session, undefined as never, key('missing')), /goalId/)
    await assert.rejects(f.host.app.goals.get({ ...f.session, hostId: 'foreign' }), /Host/)
    assert.ok((await f.host.app.capabilities()).features.includes('goals'))
  } finally {
    await f.dispose()
  }
})

test('明确配额错误进入 usage_limited，普通错误暂停且不循环重试', { timeout: 25000 }, async () => {
  for (const [message, status] of [
    ['insufficient_quota', 'usage_limited'],
    ['invalid_request', 'paused'],
  ] as const) {
    const f = await fixture({ text: message, status: 400 })
    try {
      await f.host.app.goals.start(f.session, { objective: '错误停止' }, key('start'))
      await eventually(
        () => f.host.app.goals.get(f.session),
        (goal) => goal?.status === status,
      )
      const count = f.fake.provider.requests.length
      await delay(60)
      assert.equal(f.fake.provider.requests.length, count)
    } finally {
      await f.dispose()
    }
  }
})

test('已有消息设为目标复用原生记录及图片，不复制消息、不计入历史用量', { timeout: 25000 }, async () => {
  const f = await fixture((_body, index) =>
    index === 1
      ? '已完成初步分析。'
      : {
          tool: {
            name: 'update_goal',
            arguments: JSON.stringify({ status: 'complete', summary: '完成核对', evidence: ['当前任务已经核对'] }),
          },
        },
  )
  try {
    await assert.rejects(
      f.host.app.goals.start(f.session, { objective: '无效来源', sourceMessageTimestamp: 1 }, key('invalid-source')),
      /来源消息/,
    )
    await f.host.app.sessions.submit(
      f.session,
      {
        delivery: 'start',
        text: '依据这张图完成任务',
        images: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=',
          },
        ],
      },
      key('ordinary'),
    )
    const initial = await eventually(
      () => f.host.app.sessions.snapshot(f.session),
      (snapshot) => snapshot.messages.some((message) => message.role === 'assistant') && !snapshot.state.isStreaming,
    )
    const message = initial.messages.find((message) => message.role === 'user')!
    const started = await f.host.app.goals.start(
      f.session,
      { objective: '客户端正文不得覆盖原文', sourceMessageTimestamp: message.timestamp },
      key('promote'),
    )
    assert.equal(started.goal.objective, '依据这张图完成任务')
    assert.ok(started.goal.inputEntryId)
    await eventually(
      () => f.host.app.goals.get(f.session),
      (goal) => goal?.status === 'complete',
    )
    const snapshot = await eventually(
      () => f.host.app.sessions.snapshot(f.session),
      (snapshot) => !snapshot.state.isStreaming,
    )
    assert.equal(snapshot.messages.filter((message) => message.role === 'user').length, 1)
    const goal = (await f.host.app.goals.get(f.session))!
    assert.equal(goal.tokensUsed, (f.fake.provider.requests.length - 1) * 16)
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('image_url'))
  } finally {
    await f.dispose()
  }
})

test('短暂限流沿用 SDK 重试，成功后 Goal 继续到完成', { timeout: 25000 }, async () => {
  const f = await fixture((_body, index) =>
    index === 1
      ? { status: 429, text: 'rate limit exceeded' }
      : index === 2
        ? {
            tool: {
              name: 'update_goal',
              arguments: JSON.stringify({
                status: 'complete',
                summary: '重试成功并完成验收',
                evidence: ['服务已恢复且任务已核对'],
              }),
            },
          }
        : '已完成。',
  )
  try {
    await f.host.app.goals.start(f.session, { objective: '允许短暂网络重试' }, key('retry'))
    const goal = await eventually(
      () => f.host.app.goals.get(f.session),
      (goal) => goal?.status === 'complete',
    )
    assert.equal(goal?.turns, 1)
    assert.ok(f.fake.provider.requests.length >= 2)
  } finally {
    await f.dispose()
  }
})

test('暂停后的旧停止通知不会中断新普通消息，普通消息也不会恢复目标', { timeout: 25000 }, async () => {
  const f = await fixture((_body, index) => ({ text: `完成第 ${index} 次请求`, holdMs: index === 1 ? 250 : 50 }))
  try {
    await f.host.app.goals.start(f.session, { objective: '需要暂停的目标' }, key('start'))
    await eventually(
      () => Promise.resolve(f.fake.provider.requests.length),
      (count) => count === 1,
    )
    await f.host.app.goals.pause(f.session, (await f.host.app.goals.get(f.session))!, key('pause'))
    const sent = await f.host.app.sessions.submit(
      f.session,
      { delivery: 'start', text: '暂停后独立询问' },
      key('ordinary-after-pause'),
    )
    const done = await eventually(
      () => f.host.app.sessions.receipt(sent.operationId),
      (receipt) => !['accepted', 'running', 'queued'].includes(receipt.status),
    )
    assert.equal(done.status, 'completed')
    assert.equal((await f.host.app.goals.get(f.session))?.status, 'paused')
    assert.equal(f.fake.provider.requests.length, 2)
  } finally {
    await f.dispose()
  }
})
