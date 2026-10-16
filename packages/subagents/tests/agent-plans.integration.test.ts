import assert from 'node:assert/strict'
import { test } from 'vitest'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostCollaborationBridge } from '../src/server/coordinator'
import { fakeSession, setup } from './coordinator-fixture'

test('计划运行中关闭下一轮模式不提升child权限；计划落盘ACK后才发saved', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    await context.bridge.setSessionMode('root-key', 'default')
    const child = await context.spawn('reader')
    assert.equal(child.mode, 'plan')
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '计划', markdown: '# 计划' },
        new AbortController().signal,
      ),
      /尚未全部结束/,
    )
    context.children.get(child.sessionKey)!.finish('调查完成')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.name === 'reader')!.status === 'completed',
    )
    await context.call(context.root.session, 'wait_agent', { targets: [child.agentId], timeout_ms: 0 })
    const document = await context.bridge.savePlan(
      context.root.session,
      { title: '计划', markdown: '# 计划\n具体步骤' },
      new AbortController().signal,
    )
    assert.equal(
      await readFile(path.join(context.directory, 'plans', document.sessionId, `${document.id}.md`), 'utf8'),
      document.markdown,
    )
    const next = await context.bridge.savePlan(
      context.root.session,
      { title: '修订计划', markdown: '# 修订计划' },
      new AbortController().signal,
    )
    assert.equal(next.id, document.id)
    assert.equal(next.revision, 2)
    assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 2)
  } finally {
    await context.cleanup()
  }
})

test('根会话重绑定和 Host 重启时保留计划身份，不把同目录其他会话的计划混入', async () => {
  const context = await setup()
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    await context.begin('plan')
    const document = await context.bridge.savePlan(
      context.root.session,
      { title: '已有计划', markdown: '# 已有计划\n保留正文' },
      new AbortController().signal,
    )
    const sessionFile = path.join(context.directory, 'root.jsonl')
    const binding = {
      cwd: context.directory,
      sessionFile,
      state: context.root.state,
      accessMode: 'workspace-write' as const,
      session: context.root.session,
    }
    const original = (await context.bridge.snapshot('root-key')).agent
    await context.bridge.bindRoot({ ...binding, sessionKey: 'root-key' })
    assert.equal((await context.bridge.snapshot('root-key')).agent.sessionId, document.sessionId)
    assert.deepEqual((await context.bridge.snapshot('root-key')).planDocuments, [document])
    await context.bridge.stopAndWait()
    restored = createHostCollaborationBridge({
      dataRoot: context.directory,
      createSession: () => {
        throw new Error('只读恢复不能创建 Worker')
      },
      emit: () => {},
    })
    await restored.bindRoot({ ...binding, sessionKey: 'restored-key' })
    const snapshot = await restored.snapshot('restored-key')
    assert.equal(snapshot.agent.agentId, original.agentId)
    assert.equal(snapshot.agent.sessionKey, 'restored-key')
    assert.deepEqual(snapshot.planDocuments, [document])
    const otherSession = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    await restored.bindRoot({
      ...binding,
      sessionKey: 'other-key',
      sessionFile: path.join(context.directory, 'other.jsonl'),
      sessionId: randomUUID(),
      session: otherSession.session,
    })
    assert.deepEqual((await restored.snapshot('other-key')).planDocuments, [])
    await restored.bindRoot({
      ...binding,
      sessionKey: 'other-key',
      sessionFile: path.join(context.directory, 'other.jsonl'),
      sessionId: otherSession.session.getActiveSession().sessionId,
      session: otherSession.session,
    })
    assert.equal(
      (await restored.snapshot('other-key')).agent.sessionId,
      otherSession.session.getActiveSession().sessionId,
    )
    assert.equal(
      await readFile(path.join(context.directory, 'plans', document.sessionId, `${document.id}.md`), 'utf8'),
      document.markdown,
    )
  } finally {
    await restored?.stopAndWait()
    await context.cleanup()
  }
})

test('文档目录无法写入时反馈失败，不发saved，不产生虚假snapshot', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    await mkdir(context.directory, { recursive: true })
    await writeFile(path.join(context.directory, 'plans'), '占用目录')
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '计划', markdown: '# 计划' },
        new AbortController().signal,
      ),
      /EEXIST|ENOTDIR/,
    )
    assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 0)
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments.length, 0)
  } finally {
    await context.cleanup()
  }
})

test('计划metadata保存失败恢复原文档revision，删除未确认新文件和临时文件', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const first = await context.bridge.savePlan(
      context.root.session,
      { title: '第一版', markdown: '# 第一版' },
      new AbortController().signal,
    )
    const plansDirectory = path.join(context.directory, 'plans', first.sessionId)
    await rm(path.join(context.directory, 'collaboration.json'))
    await mkdir(path.join(context.directory, 'collaboration.json'))
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '第二版', markdown: '# 第二版' },
        new AbortController().signal,
      ),
      /EISDIR|ENOTEMPTY/,
    )
    assert.equal(await readFile(path.join(plansDirectory, `${first.id}.md`), 'utf8'), '# 第一版')
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(plansDirectory), [`${first.id}.md`])
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]!.revision, 1)
    await rm(path.join(context.directory, 'collaboration.json'), { recursive: true })
    await context.begin('plan')
  } finally {
    await context.cleanup()
  }
})

test('计划写盘期间取消清理tmp，不改变已确认revision', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const first = await context.bridge.savePlan(
      context.root.session,
      { title: '已确认计划', markdown: '# 已确认计划' },
      new AbortController().signal,
    )
    const controller = new AbortController()
    const { watch } = await import('node:fs')
    const plansDirectory = path.join(context.directory, 'plans', first.sessionId)
    const watcher = watch(plansDirectory, (_event, filename) => {
      if (filename?.endsWith('.tmp')) controller.abort()
    })
    try {
      await assert.rejects(
        context.bridge.savePlan(
          context.root.session,
          { title: '取消修订', markdown: '内容\n'.repeat(1000000) },
          controller.signal,
        ),
        /取消或更换/,
      )
    } finally {
      watcher.close()
    }
    const { readdir } = await import('node:fs/promises')
    assert.equal(await readFile(path.join(plansDirectory, `${first.id}.md`), 'utf8'), '# 已确认计划')
    assert.deepEqual(await readdir(plansDirectory), [`${first.id}.md`])
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]!.revision, 1)
    assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 1)
  } finally {
    await context.cleanup()
  }
})

test('child已completed但queued followup尚未启动时不能保存计划或结束树', async () => {
  const context = await setup()
  let release!: () => void
  try {
    await context.begin('plan')
    const child = await context.spawn('worker')
    await context.call(context.root.session, 'followup_task', { target: child.agentId, message: '后续调查' })
    context.root.faults.deliveryGate = new Promise<void>((resolve) => {
      release = resolve
    })
    context.children.get(child.sessionKey)!.finish('首轮结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    await assert.rejects(
      context.bridge.savePlan(
        context.root.session,
        { title: '提前保存', markdown: '# 提前保存' },
        new AbortController().signal,
      ),
      /子 Agent 尚未全部结束或结果尚未读取/,
    )
    const settling = context.bridge.rootSettled('root-key')
    await context.until(
      async () =>
        context.root.delivered.length === 0 && (await context.bridge.getAgents('root-key'))[0]!.status === 'running',
    )
    assert.notEqual((await context.bridge.getAgents('root-key'))[0]!.status, 'completed')
    release()
    await settling
  } finally {
    release?.()
    await context.cleanup()
  }
})

test('Host停止等待计划写入和回滚完成，停止ACK后不再产生文档或saved事件', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const sessionId = context.root.session.getActiveSession().sessionId!
    const directory = path.join(context.directory, 'plans', sessionId)
    await mkdir(directory, { recursive: true })
    const { watch } = await import('node:fs')
    let stopped!: Promise<void>
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let started = false
    const watcher = watch(directory, (_event, filename) => {
      if (!started && filename?.endsWith('.tmp')) {
        started = true
        stopped = context.bridge.stopAndWait()
        enter()
      }
    })
    let saveSettled = false
    const saving = context.bridge
      .savePlan(
        context.root.session,
        { title: '停止期间文档', markdown: '内容\n'.repeat(4000000) },
        new AbortController().signal,
      )
      .finally(() => {
        saveSettled = true
      })
    const rejection = assert.rejects(saving, /取消或更换/)
    try {
      await entered
      await stopped
      assert.equal(saveSettled, true)
      await rejection
      const { readdir } = await import('node:fs/promises')
      assert.deepEqual(await readdir(directory), [])
      assert.equal(context.events.filter((event) => event.event.type === 'plan_saved').length, 0)
      assert.equal((await context.bridge.snapshot('root-key')).agent.status, 'stopped')
    } finally {
      watcher.close()
    }
  } finally {
    await context.cleanup()
  }
})
