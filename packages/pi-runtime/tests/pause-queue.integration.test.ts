import assert from 'node:assert/strict'
import { test, describe } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { QueuedInput } from '@pi-meme/contracts/plan'
import type { PiEvent } from '@pi-meme/contracts/pi'
import { SdkSession, type RuntimePolicy } from '../src/sdk/session'
import { PiSessionPool } from '../src/session-pool'
import { readSessionHistory } from '../src/session-history'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function fixture(
  reply: NonNullable<Parameters<typeof useFakeAgent>[1]>['reply'],
  configure?: (session: SdkSession) => void,
  policy: RuntimePolicy = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-pause-queue-'))
  const fake = await useFakeAgent(directory, { reply })
  const config = JSON.parse(await readFile(fake.modelsFile, 'utf8'))
  config.providers.fake.models[0].input = ['text', 'image']
  await writeFile(fake.modelsFile, JSON.stringify(config))
  await writeFile(path.join(fake.agentDir, 'settings.json'), JSON.stringify({ images: { autoResize: false } }))
  const events: PiEvent[] = []
  let queue: QueuedInput[] = []
  const session = new SdkSession(
    directory,
    {
      connection: () => {},
      error: () => {},
      event: ({ event }) => {
        if (event.type === 'queue_update') queue = structuredClone([...event.steering, ...event.followUp])
        events.push(event as PiEvent)
      },
    },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    policy,
  )
  configure?.(session)
  session.start(directory)
  await session.snapshot()
  await session.setModel({ provider: 'fake', id: 'first' })
  return {
    session,
    fake,
    events,
    queue: () => queue,
    dispose: async () => {
      await session.stopAndWait()
      await fake.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待运行状态超时')
    await delay(10)
  }
}

test('停止当前任务后保留排队输入，继续任务不释放队列', async () => {
  const f = await fixture(() => ({ text: '执行结果', delayMs: 200 }))
  try {
    await f.session.prompt('原任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.followUp('稍后执行')
    await f.session.stopTask()
    const stopped = await f.session.snapshot()
    assert.equal(stopped.state.stopped, true)
    assert.equal(stopped.state.queuePaused, true)
    assert.deepEqual(
      f.queue().map((input) => input.text),
      ['稍后执行'],
    )
    await f.session.continueStopped()
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    assert.deepEqual(
      f.queue().map((input) => input.text),
      ['稍后执行'],
    )
  } finally {
    await f.dispose()
  }
})

test('重新打开停止的会话后仍保留恢复入口和未执行队列', async () => {
  const f = await fixture(() => ({ text: '执行结果', delayMs: 200 }))
  let restored: SdkSession | undefined
  try {
    await f.session.prompt('原任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.followUp('等待确认的任务')
    await f.session.stopTask()
    const file = f.session.getActiveSession().sessionFile!
    await f.session.stopAndWait()
    restored = new SdkSession(
      f.fake.runtimePaths.dataRoot,
      { connection: () => {}, error: () => {}, event: () => {} },
      f.fake.runtimePaths,
      f.fake.credentials,
    )
    restored.start(f.fake.runtimePaths.dataRoot, file)
    const snapshot = await restored.snapshot()
    assert.equal(snapshot.state.stopped, true)
    assert.equal(snapshot.state.queuePaused, true)
    assert.equal(snapshot.state.pendingMessageCount, 1)
    await restored.continueStopped()
    await until(async () => !(await restored!.snapshot()).state.isStreaming)
    const continued = await restored.snapshot()
    assert.equal(continued.state.stopped, false)
    assert.equal(continued.state.queuePaused, true)
    assert.equal(continued.state.pendingMessageCount, 1)
  } finally {
    await restored?.stopAndWait()
    await f.dispose()
  }
})

test('冷会话显示停止与排队状态，继续队列会启动运行时并执行消息', async () => {
  const f = await fixture(() => ({ text: '队列已执行', delayMs: 200 }))
  let pool: PiSessionPool | undefined
  try {
    await f.session.prompt('原任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.followUp('排队消息')
    await f.session.stopTask()
    const file = f.session.getActiveSession().sessionFile!
    await f.session.stopAndWait()
    assert.equal((await readSessionHistory(file)).taskControl?.stopped, true)

    pool = new PiSessionPool(
      f.fake.runtimePaths.dataRoot,
      { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
      undefined,
      f.fake.runtimePaths,
      f.fake.credentials,
    )
    pool.prepare(f.fake.runtimePaths.dataRoot)
    await pool.switchSession(file)
    const snapshot = await pool.snapshot()
    assert.equal(snapshot.state.stopped, true)
    assert.equal(snapshot.state.queuePaused, true)
    assert.equal(snapshot.state.pendingMessageCount, 1)
    const queue = snapshot.events?.find((value) => value.event.type === 'queue_update')?.event
    assert.equal(queue?.type === 'queue_update' && queue.followUp[0]?.text, '排队消息')

    await pool.resume(pool.connection().sessionKey!)
    await until(() => f.fake.provider.requests.length === 2)
    await until(() => !pool!.getRuntimeSessions().some((record) => record.running))
    assert.equal((await pool.snapshot()).state.pendingMessageCount, 0)
  } finally {
    await pool?.stopAndWait()
    await f.dispose()
  }
})

test('暂停冻结流式视图，恢复保持同一请求；旧修订不能重新暂停，停止释放门控', async () => {
  const f = await fixture(() => ({ text: '恢复前已发出的正文', delayMs: 100 }))
  try {
    await f.session.prompt('初始任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.setPaused(true, 2)
    const paused = await f.session.snapshot()
    await delay(180)
    assert.deepEqual((await f.session.snapshot()).messages, paused.messages)
    assert.equal((await f.session.snapshot()).state.isStreaming, true)
    assert.equal((await f.session.snapshot()).state.queuePaused, true)
    await f.session.setPaused(false, 3)
    await f.session.setPaused(true, 2)
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal((await f.session.snapshot()).state.isPaused, false)
    await f.session.prompt('停止任务')
    await f.session.pause()
    await f.session.abort()
  } finally {
    await f.dispose()
  }
})

test('暂停区间在重复控制、恢复、停止和快照中保持准确', async () => {
  const f = await fixture(() => ({ text: '完成', delayMs: 200 }))
  try {
    await f.session.prompt('计时任务')
    await until(() => f.fake.provider.requests.length === 1)
    await f.session.setPaused(true, 10)
    const first = (await f.session.snapshot()).state.pauseIntervals
    assert.equal(first?.length, 1)
    assert.equal(first![0]!.endedAt, undefined)
    await delay(20)
    await f.session.setPaused(true, 11)
    assert.deepEqual((await f.session.snapshot()).state.pauseIntervals, first)
    await f.session.setPaused(false, 12)
    const resumed = (await f.session.snapshot()).state.pauseIntervals!
    assert.ok(resumed[0]!.endedAt! >= first![0]!.startedAt + 20)
    await f.session.setPaused(true, 11)
    await f.session.setPaused(true, 12)
    assert.deepEqual((await f.session.snapshot()).state.pauseIntervals, resumed)
    await f.session.setPaused(true, 13)
    await f.session.abort()
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    const finished = (await f.session.snapshot()).state.pauseIntervals!
    assert.equal(finished.length, 2)
    assert.ok(finished.every((interval) => interval.endedAt !== undefined))
    const lastPause = f.events.filter((event) => event.type === 'pause_update').at(-1)
    assert.ok(lastPause?.type === 'pause_update')
    assert.deepEqual(lastPause.pauseIntervals, finished)
    await delay(20)
    assert.deepEqual((await f.session.snapshot()).state.pauseIntervals, finished)
  } finally {
    await f.dispose()
  }
})

test('恢复后的同一运行保留起点，完成快照带真实终点并排除全部暂停时间', async () => {
  const f = await fixture(() => ({ text: '完成', delayMs: 150 }))
  try {
    await f.session.prompt('计时完成任务')
    await until(() => f.fake.provider.requests.length === 1)
    const running = (await f.session.snapshot()).state.runIntervals!
    assert.equal(running.length, 1)
    for (let revision = 1; revision <= 3; revision += 2) {
      await f.session.setPaused(true, revision)
      await delay(30)
      await f.session.setPaused(false, revision + 1)
    }
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    const completed = (await f.session.snapshot()).state
    assert.equal(completed.runIntervals?.length, 1)
    assert.equal(completed.runIntervals![0]!.startedAt, running[0]!.startedAt)
    const run = completed.runIntervals![0]!
    assert.ok(run.endedAt! > run.startedAt)
    const pausedMs = completed.pauseIntervals!.reduce(
      (total, interval) =>
        total + Math.max(0, Math.min(run.endedAt!, interval.endedAt!) - Math.max(run.startedAt, interval.startedAt)),
      0,
    )
    assert.ok(pausedMs >= 60)
    assert.ok(run.endedAt! - run.startedAt - pausedMs >= 0)
    assert.equal(f.fake.provider.requests.length, 1)
    const settled = f.events.findLast((event) => event.type === 'agent_settled')
    assert.ok(settled?.type === 'agent_settled')
    assert.deepEqual(settled.runIntervals, completed.runIntervals)
    await f.session.reconnectModels()
    const restored = (await f.session.snapshot()).state
    assert.deepEqual(restored.runIntervals, completed.runIntervals)
    assert.deepEqual(restored.pauseIntervals, completed.pauseIntervals)
  } finally {
    await f.dispose()
  }
})

test('同目录新会话和扩展新会话清空计时，内部重建保留计时', async () => {
  const f = await fixture(
    () => '完成',
    (session) => {
      session.configureInlineExtensions([
        {
          name: '新会话测试',
          factory: (pi) => {
            pi.registerCommand('fresh-session', {
              description: '新建测试会话',
              handler: async (_args, ctx) => {
                await ctx.newSession()
              },
            })
          },
        },
      ])
    },
  )
  try {
    await f.session.pause()
    await f.session.resume()
    assert.equal((await f.session.snapshot()).state.pauseIntervals?.length, 1)
    f.session.start(f.session.cwd)
    let state = (await f.session.snapshot()).state
    assert.deepEqual(state.pauseIntervals, [])
    assert.deepEqual(state.runIntervals, [])
    await f.session.setModel({ provider: 'fake', id: 'first' })
    await f.session.prompt('旧任务')
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    await f.session.pause()
    await f.session.resume()
    const previous = (await f.session.snapshot()).state
    await f.session.reconnectModels()
    state = (await f.session.snapshot()).state
    assert.deepEqual(state.pauseIntervals, previous.pauseIntervals)
    assert.deepEqual(state.runIntervals, previous.runIntervals)
    await f.session.prompt('/fresh-session')
    state = (await f.session.snapshot()).state
    assert.deepEqual(state.pauseIntervals, [])
    assert.deepEqual(state.runIntervals, [])
  } finally {
    await f.dispose()
  }
})

test('新一代启动允许重放缓存暂停控制，同代重复修订和旧修订不改变门闸', async () => {
  const f = await fixture(() => '完成')
  try {
    await f.session.setPaused(true, 3)
    f.session.start(f.session.cwd)
    await f.session.setPaused(true, 3)
    const paused = (await f.session.snapshot()).state
    assert.equal(paused.isPaused, true)
    assert.equal(paused.pauseIntervals?.length, 1)
    await f.session.setPaused(true, 3)
    await f.session.setPaused(false, 2)
    assert.deepEqual((await f.session.snapshot()).state.pauseIntervals, paused.pauseIntervals)
    assert.equal((await f.session.snapshot()).state.isPaused, true)
    await f.session.setPaused(false, 4)
    await f.session.setPaused(true, 4)
    assert.equal((await f.session.snapshot()).state.isPaused, false)
    await f.session.reconnectModels()
    await f.session.setPaused(true, 4)
    assert.equal((await f.session.snapshot()).state.isPaused, false)
  } finally {
    await f.dispose()
  }
})

test('FIFO保留图片、模式和id；编辑队首阻止出队，跨客户端操作拒绝，释放后逐条执行', async () => {
  const f = await fixture((_body, index) => ({ text: `完成${index}`, holdMs: index === 1 ? 100 : 0 }))
  try {
    await f.session.prompt('初始任务')
    const image = {
      type: 'image' as const,
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=',
    }
    await f.session.followUp('', [image])
    await f.session.followUp('计划输入', undefined, [], { mode: 'plan' })
    const [first, second] = f.queue()
    assert.ok(first && second)
    assert.deepEqual(first.images, [image])
    await f.session.beginQueueEdit(first.id, '甲')
    await assert.rejects(f.session.beginQueueEdit(first.id, '乙'), /正在编辑/)
    await assert.rejects(f.session.cancelQueueEdit(first.id, '乙'), /编辑权/)
    await delay(180)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal(f.queue()[0]?.id, first.id)
    await f.session.updateQueueInput(first.id, '修改后的图片输入', [image], [], { mode: 'default' }, '甲')
    await until(async () => f.fake.provider.requests.length === 3 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.queue().length, 0)
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('修改后的图片输入'))
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('image_url'))
    assert.ok(JSON.stringify(f.fake.provider.requests[2]).includes('计划输入'))
    await assert.rejects(f.session.deleteQueueInput(second.id), /已发送/)
  } finally {
    await f.dispose()
  }
})

test('暂停允许删队列与取消编辑；按id引导只移交目标，跨模式拒绝且保持队列', async () => {
  const f = await fixture((_body, index) => ({ text: `完成${index}`, delayMs: 80 }))
  try {
    await f.session.prompt('初始任务')
    await f.session.pause()
    await f.session.followUp('要删除')
    await f.session.followUp('选中引导')
    await f.session.followUp('不同模式', undefined, [], { mode: 'plan' })
    const [remove, steer, plan] = f.queue()
    assert.ok(remove && steer && plan)
    await f.session.beginQueueEdit(remove.id, '甲')
    await f.session.cancelQueueEdit(remove.id, '甲')
    await f.session.deleteQueueInput(remove.id)
    await assert.rejects(f.session.steerQueueInput(plan.id), /不同模式/)
    await f.session.steerQueueInput(steer.id)
    assert.equal(f.queue().filter((input) => input.id === steer.id).length, 1)
    assert.equal((await f.session.snapshot()).state.isPaused, true)
    await f.session.resume()
    await until(async () => f.queue().length === 0 && !(await f.session.snapshot()).state.isStreaming)
    assert.ok(f.fake.provider.requests.some((request) => JSON.stringify(request).includes('选中引导')))
  } finally {
    await f.dispose()
  }
})

test('工具执行期间重复引导保持原生插话id，工具返回后只发送一次且保留协作消息', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(
    (_body, index) =>
      index === 1
        ? { tool: { name: 'codemode', arguments: JSON.stringify({ code: 'text(await tools.wait_here({}));' }) } }
        : '插话完成',
    (session) => {
      session.configureInlineExtensions([
        {
          name: '原生插话测试',
          factory: (pi) => {
            pi.registerTool({
              name: 'wait_here',
              label: '等待工具',
              description: '等待测试释放工具',
              parameters: { type: 'object', properties: {} },
              execute: async () => {
                entered()
                await waiting
                return { content: [{ type: 'text', text: '工具完成' }], details: {} }
              },
            })
          },
        },
      ])
    },
  )
  try {
    await f.session.setSteeringMode('all')
    await f.session.prompt('启动等待工具')
    await started
    await f.session.followUp('用户插话')
    const input = f.queue()[0]
    assert.ok(input)
    assert.equal(input.submitted, undefined)
    const mailbox = {
      id: '子代理汇报id',
      fromAgentId: '/root/child',
      toAgentId: '/root',
      rootTaskId: '任务id',
      epoch: 1,
      kind: 'message' as const,
      text: '子代理仍在执行',
      createdAt: new Date().toISOString(),
    }
    assert.deepEqual(await f.session.deliverCollaborationMessage(mailbox), { persisted: false })
    await f.session.steerQueueInput(input.id)
    await f.session.steerQueueInput(input.id)
    assert.equal(f.queue()[0]?.submitted, true)
    await f.session.steer('直接用户插话')
    const direct = f.queue()[1]
    assert.ok(direct?.submitted)
    await f.session.steerQueueInput(direct.id)
    assert.deepEqual(
      f.queue().map((value) => value.id),
      [input.id, direct.id],
    )
    assert.equal(f.fake.provider.requests.length, 1)
    release()
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.fake.provider.requests.length, 2)
    assert.equal(f.queue().length, 0)
    const users = (await f.session.snapshot()).messages.filter((message) => message.role === 'user')
    for (const text of ['用户插话', '直接用户插话'])
      assert.equal(
        users.filter((message) => JSON.stringify(message.content) === JSON.stringify([{ type: 'text', text }])).length,
        1,
      )
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('子代理仍在执行'))
    assert.deepEqual(await f.session.deliverCollaborationMessage(mailbox), { persisted: true })
    await assert.rejects(f.session.steerQueueInput(input.id), /已发送/)
  } finally {
    release()
    await f.dispose()
  }
})

test('排队准入失败原位恢复并暂停队列，恢复后不会丢失输入；客户端离开释放编辑占位', async () => {
  const f = await fixture(() => ({ text: '完成', holdMs: 80 }))
  try {
    await f.session.prompt('初始任务')
    await f.session.followUp('保留原项')
    await f.session.followUp('后续项')
    const first = f.queue()[0]!
    await f.session.beginQueueEdit(first.id, '甲')
    await delay(140)
    const original = f.session.prompt.bind(f.session)
    f.session.prompt = async () => {
      throw new Error('测试准入失败')
    }
    await f.session.releaseQueueEdits('甲')
    await until(async () => Boolean((await f.session.snapshot()).state.queuePaused))
    assert.equal(f.queue()[0]?.id, first.id)
    assert.equal(f.queue()[0]?.editing, undefined)
    assert.equal(f.queue()[1]?.text, '后续项')
    await f.session.followUp('新增项')
    assert.equal(f.fake.provider.requests.length, 1)
    f.session.prompt = original
    await f.session.resume()
    await until(async () => f.fake.provider.requests.length === 4 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.queue().length, 0)
  } finally {
    await f.dispose()
  }
})

test('暂停在codemode嵌套tool_call边界阻止后续工具，已执行工具可返回；恢复继续同一run', async () => {
  let first = 0
  let second = 0
  const f = await fixture(
    (_body, index) =>
      index === 1
        ? {
            tool: {
              name: 'codemode',
              arguments: JSON.stringify({ code: 'text(await tools.pause_here({})); text(await tools.next_tool({}));' }),
            },
          }
        : '组合完成',
    (session) => {
      session.configureInlineExtensions([
        {
          name: 'pause-test',
          factory: (pi) => {
            pi.registerTool({
              name: 'pause_here',
              label: '暂停点',
              description: '到此暂停',
              exposure: 'deferred',
              parameters: { type: 'object', properties: {} } as never,
              execute: async () => {
                first += 1
                await session.pause()
                return { content: [{ type: 'text', text: '首个工具已返回' }], details: {} }
              },
            })
            pi.registerTool({
              name: 'next_tool',
              label: '后续工具',
              description: '恢复后执行',
              exposure: 'deferred',
              parameters: { type: 'object', properties: {} } as never,
              execute: async () => {
                second += 1
                return { content: [{ type: 'text', text: '后续工具完成' }], details: {} }
              },
            })
          },
        },
      ])
    },
  )
  try {
    await f.session.prompt('执行组合工具')
    await until(() => first === 1)
    const frozen = await f.session.snapshot()
    await delay(80)
    assert.equal(second, 0)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.deepEqual((await f.session.snapshot()).messages, frozen.messages)
    await f.session.resume()
    await until(async () => second === 1 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(first, 1)
    assert.equal(f.fake.provider.requests.length, 2)
  } finally {
    await f.dispose()
  }
})

test('纯图片排队不依赖正文，技能引用在编辑取消及引导失败后完整保留', async () => {
  const f = await fixture((_body, index) => ({ text: `完成${index}`, delayMs: 80 }))
  try {
    await f.session.prompt('初始任务')
    await f.session.pause()
    const image = {
      type: 'image' as const,
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=',
    }
    await f.session.followUp('', [image])
    await f.session.followUp('\uFFFC 技能任务', undefined, [{ name: '未安装技能', id: 'missing', revision: '1' }])
    const [picture, skill] = f.queue()
    assert.ok(picture && skill)
    await f.session.beginQueueEdit(skill.id, '甲')
    await f.session.cancelQueueEdit(skill.id, '甲')
    await assert.rejects(f.session.steerQueueInput(skill.id), /技能/)
    assert.deepEqual(
      f.queue().map((input) => input.id),
      [picture.id, skill.id],
    )
    assert.deepEqual(f.queue()[1]?.skills, [{ name: '未安装技能', id: 'missing', revision: '1' }])
    await f.session.deleteQueueInput(skill.id)
    await f.session.resume()
    await until(async () => f.fake.provider.requests.length === 2 && !(await f.session.snapshot()).state.isStreaming)
    const user = (await f.session.snapshot()).messages.filter((message) => message.role === 'user').at(-1)
    assert.ok(user?.role === 'user' && Array.isArray(user.content))
    assert.ok(user.content.some((part) => part.type === 'image'))
  } finally {
    await f.dispose()
  }
})

test('已显示首段正文后暂停，后台完整生成不修改冻结快照；恢复只有原用户消息和完整回复', async () => {
  const reply = '首段正文'.repeat(30)
  const f = await fixture(() => ({ text: reply, chunkDelayMs: 25 }))
  try {
    await f.session.prompt('原始唯一任务')
    await until(() =>
      f.events.some((event) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'),
    )
    await f.session.pause()
    const frozen = await f.session.snapshot()
    const deltaCount = f.events.filter((event) => event.type === 'message_update').length
    await delay(250)
    assert.deepEqual((await f.session.snapshot()).messages, frozen.messages)
    assert.equal(f.events.filter((event) => event.type === 'message_update').length, deltaCount)
    await f.session.resume()
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    const messages = (await f.session.snapshot()).messages
    assert.equal(messages.filter((message) => message.role === 'user').length, 1)
    assert.equal(messages.filter((message) => message.role === 'custom').length, 0)
    const assistant = messages.find((message) => message.role === 'assistant')
    assert.ok(assistant?.role === 'assistant')
    assert.equal(
      assistant.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      reply,
    )
    assert.equal(f.fake.provider.requests.length, 1)
  } finally {
    await f.dispose()
  }
})

describe('引导准备期间Abort或自然结束，不能注入另一run；短锁仍允许编辑后续项', () => {
  for (const abort of [true, false])
    test(abort ? 'Abort' : '自然结束', async () => {
      const f = await fixture(() => ({ text: '完成', holdMs: 120 }))
      let release!: () => void
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const preparing = new Promise<void>((resolve) => {
        entered = resolve
      })
      try {
        const file = path.join(f.fake.agentDir, 'SKILL.md')
        await writeFile(file, '技能正文')
        await f.session.prompt('初始任务')
        await f.session.followUp('\uFFFC 引导任务', undefined, [{ name: 'skill:test', id: 'test', revision: '1' }])
        await f.session.followUp('后续项')
        const [first, second] = f.queue()
        assert.ok(first && second)
        f.session.getCommands = async () => {
          entered()
          await waiting
          return [
            {
              name: 'skill:test',
              resourceId: 'test',
              resourceRevision: '1',
              source: 'skill',
              sourceInfo: { path: file, source: 'desktop', scope: 'temporary', origin: 'top-level' },
            },
          ]
        }
        await until(() => f.fake.provider.requests.length === 1)
        const steering = f.session.steerQueueInput(first.id)
        const rejected = assert.rejects(steering, /结束或取消/)
        await preparing
        await f.session.beginQueueEdit(second.id, '甲')
        if (abort) await f.session.abort()
        else await until(async () => !(await f.session.snapshot()).state.isStreaming)
        assert.equal(f.fake.provider.requests.length, 1)
        release()
        await rejected
        assert.equal(f.queue()[0]?.id, first.id)
        assert.equal(f.queue()[1]?.id, second.id)
      } finally {
        release()
        await f.dispose()
      }
    })
})

test('后台暂停或保留编辑队列的会话不会被空闲回收，释放客户端编辑不唤醒冷会话', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-background-queue-'))
  const fake = await useFakeAgent(directory, { reply: { text: '完成', holdMs: 60 } })
  const sessions = new Map<string, SdkSession>()
  let changes = 0
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {
        changes += 1
      },
    },
    undefined,
    fake.runtimePaths,
    fake.credentials,
    (cwd, notify, paths, credentials, mcp, key) => {
      const session = new SdkSession(cwd, notify, paths, credentials, mcp)
      sessions.set(key!, session)
      return session
    },
  )
  const view = pool.createClientView()
  view.clientId = '客户端甲'
  try {
    await pool.withClientView(view, async () => {
      pool.start(directory)
      const paused = pool.connection().sessionKey!
      await pool.prompt(paused, '后台暂停任务')
      await until(() => pool.getRuntimeSessions().every((record) => !record.running))
      const beforePause = changes
      await pool.pause(paused)
      assert.ok(changes > beforePause)
      const pausedSnapshot = await pool.snapshot()
      assert.equal(pausedSnapshot.state.isPaused, true)
      assert.equal(pausedSnapshot.state.pauseIntervals?.length, 1)
      assert.equal(pool.getRuntimeSessions().find((record) => record.id === paused)?.isPaused, true)
      pool.publishSessionEvent(paused, {
        generation: pool.connection().generation,
        event: { type: 'pause_update', isPaused: false, queuePaused: false, revision: 0, pauseIntervals: [] },
      })
      const repeated = await pool.snapshot()
      assert.equal(repeated.state.isPaused, true)
      assert.deepEqual(repeated.state.pauseIntervals, pausedSnapshot.state.pauseIntervals)
      const sdkSession = sessions.get(paused)!
      const readSnapshot = sdkSession.snapshot.bind(sdkSession)
      let releaseSnapshot!: () => void
      let capturedSnapshot!: () => void
      const captured = new Promise<void>((resolve) => {
        capturedSnapshot = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        releaseSnapshot = resolve
      })
      sdkSession.snapshot = async () => {
        const old = await readSnapshot()
        capturedSnapshot()
        await blocked
        return old
      }
      const reading = pool.snapshot()
      await captured
      await pool.abort(paused)
      releaseSnapshot()
      const afterAbort = await reading
      assert.equal(afterAbort.state.isPaused, false)
      assert.ok(afterAbort.state.pauseIntervals?.every((interval) => interval.endedAt !== undefined))
      sdkSession.snapshot = readSnapshot
      await pool.pause(paused)
      await pool.newSession()
      const editing = pool.connection().sessionKey!
      await pool.prompt(editing, '后台编辑任务')
      await pool.followUp(editing, '暂不发送')
      const queueEvent = (await pool.snapshot()).events?.find((value) => value.event.type === 'queue_update')?.event
      assert.ok(queueEvent?.type === 'queue_update')
      await pool.beginQueueEdit(editing, queueEvent.followUp[0]!.id)
      await until(() => pool.getRuntimeSessions().every((record) => !record.running))
      for (let i = 0; i < 5; i += 1) {
        await pool.newSession()
        await pool.prompt(pool.connection().sessionKey!, `普通任务${i}`)
        await until(() => pool.getRuntimeSessions().every((record) => !record.running))
      }
      assert.equal(sessions.get(paused)!.connection().status, 'ready')
      assert.equal(pool.getRuntimeSessions().find((record) => record.id === paused)?.isPaused, true)
      assert.equal(sessions.get(editing)!.connection().status, 'ready')
      await pool.newSession()
      const cold = sessions.get(pool.connection().sessionKey!)!
      await pool.releaseQueueEdits('客户端甲')
      assert.equal(cold.connection().status, 'disconnected')
      await until(() => pool.getRuntimeSessions().every((record) => !record.running))
    })
  } finally {
    await pool.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('跨模式排队准备期间暂停，内部重建保留暂停修订与冻结视图，恢复才发送下一请求', async () => {
  const f = await fixture(() => '完成')
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparing = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    await f.session.prompt('初始任务')
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    const capture = f.session.captureRestoreState.bind(f.session)
    f.session.captureRestoreState = async () => {
      const restore = await capture()
      entered()
      await waiting
      return restore
    }
    const sending = f.session.followUp('下一计划任务', undefined, [], { mode: 'plan' })
    const result = sending.then(
      () => undefined,
      (cause: unknown) => cause,
    )
    await preparing
    await f.session.setPaused(true, 41)
    const frozen = await f.session.snapshot()
    release()
    await until(
      async () => f.events.some((event) => event.type === 'agent_start') && f.session.connection().status === 'ready',
    )
    await delay(120)
    const paused = await f.session.snapshot()
    assert.equal(paused.state.isPaused, true)
    assert.equal(paused.state.queuePaused, true)
    assert.equal(paused.state.pauseRevision, 41)
    assert.deepEqual(paused.messages, frozen.messages)
    assert.deepEqual(paused.state.pauseIntervals, frozen.state.pauseIntervals)
    assert.equal(paused.state.pauseIntervals?.at(-1)?.endedAt, undefined)
    assert.equal(f.fake.provider.requests.length, 1)
    await f.session.setPaused(false, 42)
    assert.equal(await result, undefined)
    await until(async () => f.fake.provider.requests.length === 2 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal((await f.session.snapshot()).messages.filter((message) => message.role === 'user').length, 2)
  } finally {
    release()
    await f.dispose()
  }
})

test('内部重建等待session_start期间恢复再暂停，最新修订保留且不提前启动模型', async () => {
  let starts = 0
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const rebuilding = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = await fixture(
    () => '完成',
    (session) => {
      session.configureInlineExtensions([
        {
          name: 'pi-meme-collaboration',
          factory: (pi) => {
            pi.on('session_start', async () => {
              starts += 1
              if (starts !== 2) return
              entered()
              await waiting
            })
          },
        },
      ])
    },
  )
  try {
    await f.session.prompt('初始任务')
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    await f.session.setPaused(true, 50)
    const sending = f.session.prompt('下一计划任务', undefined, [], { mode: 'plan' })
    const result = sending.then(
      () => undefined,
      (cause: unknown) => cause,
    )
    await rebuilding
    await f.session.setPaused(false, 51)
    await f.session.setPaused(true, 52)
    release()
    await until(() => f.session.connection().status === 'ready')
    await delay(100)
    const paused = await f.session.snapshot()
    assert.equal(paused.state.isPaused, true)
    assert.equal(paused.state.queuePaused, true)
    assert.equal(paused.state.pauseRevision, 52)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal(f.events.filter((event) => event.type === 'agent_start').length, 1)
    await f.session.setPaused(false, 53)
    assert.equal(await result, undefined)
    await until(async () => f.fake.provider.requests.length === 2 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(starts, 2)
    assert.equal(f.events.filter((event) => event.type === 'agent_start').length, 2)
  } finally {
    release()
    await f.dispose()
  }
})

test('已选队列的技能准备期间暂停，恢复前不增加用户消息或模型请求', async () => {
  const f = await fixture(() => '完成')
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparing = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    await f.session.prompt('初始任务')
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    const file = path.join(f.fake.agentDir, 'queue-SKILL.md')
    await writeFile(file, '技能正文')
    f.session.getCommands = async () => {
      entered()
      await waiting
      return [
        {
          name: 'skill:test',
          resourceId: 'test',
          resourceRevision: '1',
          source: 'skill',
          sourceInfo: { path: file, source: 'desktop', scope: 'temporary', origin: 'top-level' },
        },
      ]
    }
    const sending = f.session.followUp('\uFFFC 排队任务', undefined, [
      { name: 'skill:test', id: 'test', revision: '1' },
    ])
    const result = sending.then(
      () => undefined,
      (cause: unknown) => cause,
    )
    await preparing
    await f.session.setPaused(true, 70)
    const frozen = await f.session.snapshot()
    release()
    await delay(100)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal(f.events.filter((event) => event.type === 'agent_start').length, 1)
    assert.deepEqual((await f.session.snapshot()).messages, frozen.messages)
    assert.equal(
      (await f.session.getEntries()).entries.filter(
        (entry) => entry.type === 'message' && entry.message.role === 'user',
      ).length,
      1,
    )
    await f.session.setPaused(false, 71)
    assert.equal(await result, undefined)
    await until(async () => f.fake.provider.requests.length === 2 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(f.events.filter((event) => event.type === 'agent_start').length, 2)
    assert.ok(JSON.stringify(f.fake.provider.requests[1]).includes('技能正文'))
  } finally {
    release()
    await f.dispose()
  }
})

test('任务准入期间暂停，恢复继续已准入轮次，不重复准入或替换任务', async () => {
  let admissions = 0
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const admitting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = await fixture(() => '完成', undefined, {
    onAdmission: async () => {
      admissions += 1
      if (admissions !== 2) return
      entered()
      await waiting
    },
  })
  try {
    await f.session.prompt('初始任务')
    await until(async () => !(await f.session.snapshot()).state.isStreaming)
    const sending = f.session.followUp('已准入任务')
    const result = sending.then(
      () => undefined,
      (cause: unknown) => cause,
    )
    await admitting
    await f.session.setPaused(true, 80)
    const frozen = await f.session.snapshot()
    release()
    await delay(100)
    assert.equal(f.fake.provider.requests.length, 1)
    assert.equal(admissions, 2)
    assert.deepEqual((await f.session.snapshot()).messages, frozen.messages)
    assert.equal((await f.session.snapshot()).state.isStreaming, false)
    await f.session.followUp('后续必须排队')
    await delay(30)
    assert.equal(admissions, 2)
    await f.session.setPaused(false, 81)
    assert.equal(await result, undefined)
    await until(async () => f.fake.provider.requests.length === 3 && !(await f.session.snapshot()).state.isStreaming)
    assert.equal(admissions, 3)
    assert.equal(f.events.filter((event) => event.type === 'agent_start').length, 3)
    assert.equal((await f.session.snapshot()).messages.filter((message) => message.role === 'user').length, 3)
  } finally {
    release()
    await f.dispose()
  }
})
