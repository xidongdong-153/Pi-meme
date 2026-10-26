import assert from 'node:assert/strict'
import { test } from 'vitest'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostCollaborationBridge } from '../src/server/coordinator'
import { fakeSession, setup } from './coordinator-fixture'

test('普通跨轮规划更新唯一方案，回退恢复正文且旧引用失效，清空后不能复活', async () => {
  const context = await setup()
  const signal = new AbortController().signal
  try {
    await context.begin('plan')
    const first = await context.savePlan(context.root.session, { title: '初稿', markdown: '# 初稿' }, signal)
    const retained = context.root.entries.slice()
    await context.begin('plan')
    const second = await context.savePlan(context.root.session, { title: '调整稿', markdown: '# 调整稿' }, signal)
    assert.equal(second.id, first.id)
    assert.deepEqual((await context.bridge.snapshot('root-key')).planDocuments, [second])
    context.root.entries.splice(0, context.root.entries.length, ...retained)
    const restored = await context.bridge.syncPlan(context.root.session, true)
    assert.equal(restored.document?.markdown, first.markdown)
    assert.ok(restored.document!.revision > second.revision)
    await assert.rejects(context.bridge.resolvePlan(context.root.session, second, signal), /新修订/)
    context.root.entries.length = 0
    const cleared = await context.bridge.syncPlan(context.root.session, true)
    assert.equal(cleared.document, undefined)
    assert.ok(cleared.revision > restored.revision)
    assert.deepEqual((await context.bridge.snapshot('root-key')).planDocuments, [])
    await assert.rejects(context.bridge.resolvePlan(context.root.session, first, signal), /不存在/)
  } finally {
    await context.cleanup()
  }
})

test('候选写入后尚无原生保存结果，不发布方案；中断后恢复原有效状态', async () => {
  const context = await setup()
  const signal = new AbortController().signal
  try {
    await context.begin('plan')
    const first = await context.savePlan(context.root.session, { title: '有效方案', markdown: '# 有效' }, signal)
    const eventCount = context.events.filter((record) => record.event.type === 'plan_state_changed').length
    await context.bridge.savePlan(context.root.session, { title: '候选', markdown: '# 未确认' }, signal)
    assert.deepEqual((await context.bridge.snapshot('root-key')).planDocuments, [first])
    assert.equal(context.events.filter((record) => record.event.type === 'plan_state_changed').length, eventCount)
    await context.bridge.syncPlan(context.root.session, true)
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]?.markdown, '# 有效')
    assert.equal(await readFile(path.join(context.plansDataDir, first.sessionId, `${first.id}.md`), 'utf8'), '# 有效')
  } finally {
    await context.cleanup()
  }
})

test('同一会话的后一次保存等待前一次原生结果确认', async () => {
  const context = await setup()
  const signal = new AbortController().signal
  try {
    await context.begin('plan')
    const first = await context.bridge.savePlan(context.root.session, { title: '首次', markdown: '# 首次' }, signal)
    let completed = false
    const saving = context.bridge
      .savePlan(context.root.session, { title: '随后', markdown: '# 随后' }, signal)
      .then((document) => {
        completed = true
        return document
      })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(completed, false)
    context.root.appendPlan(first)
    await context.bridge.syncPlan(context.root.session)
    const second = await saving
    assert.equal(second.id, first.id)
    context.root.appendPlan(second)
    await context.bridge.syncPlan(context.root.session)
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]?.markdown, '# 随后')
  } finally {
    await context.cleanup()
  }
})

test('分叉从原生检查点继承正文并建立独立身份，后续保存不修改来源方案', async () => {
  const context = await setup()
  const signal = new AbortController().signal
  try {
    await context.begin('plan')
    const first = await context.savePlan(context.root.session, { title: '来源', markdown: '# 来源' }, signal)
    const fork = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    fork.session.start(context.directory)
    fork.appendPlan(first)
    await context.bridge.bindRoot({
      sessionKey: 'fork',
      cwd: context.directory,
      state: fork.state,
      sessionId: fork.session.getActiveSession().sessionId,
      accessMode: 'workspace-write',
      session: fork.session,
    })
    const inherited = (await context.bridge.snapshot('fork')).planDocuments[0]!
    assert.equal(inherited.markdown, first.markdown)
    assert.notEqual(inherited.id, first.id)
    assert.notEqual(inherited.sessionId, first.sessionId)
    await context.bridge.beginRootRun('fork', { mode: 'plan', message: '调整分叉方案' })
    const updated = await context.bridge.savePlan(fork.session, { title: '分叉调整', markdown: '# 独立调整' }, signal)
    fork.appendPlan(updated)
    await context.bridge.syncPlan(fork.session)
    assert.equal(updated.id, inherited.id)
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]!.markdown, first.markdown)
  } finally {
    await context.cleanup()
  }
})

test('重启丢弃没有原生结果的候选，修复正文及索引；孤立旧文件保留但不展示', async () => {
  const context = await setup()
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    await context.begin('plan')
    const first = await context.savePlan(
      context.root.session,
      { title: '有效', markdown: '# 有效' },
      new AbortController().signal,
    )
    await context.bridge.savePlan(
      context.root.session,
      { title: '候选', markdown: '# 未提交' },
      new AbortController().signal,
    )
    restored = createHostCollaborationBridge({
      dataRoot: context.directory,
      createSession: () => {
        throw new Error('不创建 Worker')
      },
      emit: () => {},
    })
    await restored.bindRoot({
      sessionKey: 'restored',
      cwd: context.directory,
      state: context.root.state,
      sessionId: first.sessionId,
      accessMode: 'workspace-write',
      session: context.root.session,
    })
    assert.equal((await restored.snapshot('restored')).planDocuments[0]!.markdown, '# 有效')
    assert.equal(await readFile(path.join(context.plansDataDir, first.sessionId, `${first.id}.md`), 'utf8'), '# 有效')
    context.root.entries.length = 0
    assert.deepEqual((await restored.snapshot('restored')).planDocuments, [])
    assert.equal(await readFile(path.join(context.plansDataDir, first.sessionId, `${first.id}.md`), 'utf8'), '# 有效')
  } finally {
    await restored?.stopAndWait()
    await context.cleanup()
  }
})

test('计划运行中关闭下一轮模式不提升child权限；计划落盘ACK后才发saved', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    await context.bridge.setSessionMode('root-key', 'default')
    const child = await context.spawn('reader')
    assert.equal(child.mode, 'plan')
    await assert.rejects(
      context.savePlan(context.root.session, { title: '计划', markdown: '# 计划' }, new AbortController().signal),
      /尚未全部结束/,
    )
    await context.children.get(child.sessionKey)!.finish('调查完成')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((agent) => agent.name === 'reader')!.status === 'completed',
    )
    await context.call(context.root.session, 'wait_agent', { targets: [child.agentId], timeout_ms: 0 })
    const document = await context.savePlan(
      context.root.session,
      { title: '计划', markdown: '# 计划\n具体步骤' },
      new AbortController().signal,
    )
    assert.equal(
      await readFile(path.join(context.plansDataDir, document.sessionId, `${document.id}.md`), 'utf8'),
      document.markdown,
    )
    const next = await context.savePlan(
      context.root.session,
      { title: '修订计划', markdown: '# 修订计划' },
      new AbortController().signal,
    )
    assert.equal(next.id, document.id)
    assert.equal(next.revision, 2)
    assert.equal(
      context.events.filter((event) => event.event.type === 'plan_state_changed' && event.event.reason === 'saved')
        .length,
      2,
    )
  } finally {
    await context.cleanup()
  }
})

test('根会话重绑定和 Host 重启时保留计划身份，不把同目录其他会话的计划混入', async () => {
  const context = await setup()
  let restored: ReturnType<typeof createHostCollaborationBridge> | undefined
  try {
    await context.begin('plan')
    const document = await context.savePlan(
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
    context.root.session.start(context.directory)
    const snapshot = await restored.snapshot('restored-key')
    assert.equal(snapshot.agent.agentId, original.agentId)
    assert.equal(snapshot.agent.sessionKey, 'restored-key')
    assert.deepEqual(snapshot.planDocuments, [document])
    const otherSession = fakeSession(context.directory, { connection: () => {}, event: () => {}, error: () => {} })
    otherSession.session.start(context.directory)
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
      await readFile(path.join(context.plansDataDir, document.sessionId, `${document.id}.md`), 'utf8'),
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
    await mkdir(path.dirname(context.plansDataDir), { recursive: true })
    await writeFile(context.plansDataDir, '占用目录')
    await assert.rejects(
      context.savePlan(context.root.session, { title: '计划', markdown: '# 计划' }, new AbortController().signal),
      /EEXIST|ENOTDIR/,
    )
    assert.equal(
      context.events.filter((event) => event.event.type === 'plan_state_changed' && event.event.reason === 'saved')
        .length,
      0,
    )
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments.length, 0)
  } finally {
    await context.cleanup()
  }
})

test('计划metadata保存失败恢复原文档revision，删除未确认新文件和临时文件', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const first = await context.savePlan(
      context.root.session,
      { title: '第一版', markdown: '# 第一版' },
      new AbortController().signal,
    )
    const plansDirectory = path.join(context.plansDataDir, first.sessionId)
    await mkdir(path.dirname(context.plansIndexFile), { recursive: true })
    await rm(context.plansIndexFile, { force: true })
    await mkdir(context.plansIndexFile)
    await assert.rejects(
      context.savePlan(context.root.session, { title: '第二版', markdown: '# 第二版' }, new AbortController().signal),
      /EISDIR|ENOTEMPTY|EEXIST/,
    )
    assert.equal(await readFile(path.join(plansDirectory, `${first.id}.md`), 'utf8'), '# 第一版')
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(plansDirectory), [`${first.id}.md`])
    assert.equal((await context.bridge.snapshot('root-key')).planDocuments[0]!.revision, 1)
    await rm(context.plansIndexFile, { recursive: true, force: true })
    await context.begin('plan')
  } finally {
    await context.cleanup()
  }
})

test('计划写盘期间取消清理tmp，不改变已确认revision', async () => {
  const context = await setup()
  try {
    await context.begin('plan')
    const first = await context.savePlan(
      context.root.session,
      { title: '已确认计划', markdown: '# 已确认计划' },
      new AbortController().signal,
    )
    const controller = new AbortController()
    const { watch } = await import('node:fs')
    const plansDirectory = path.join(context.plansDataDir, first.sessionId)
    await mkdir(plansDirectory, { recursive: true })
    const watcher = watch(plansDirectory, (_event, filename) => {
      if (filename?.endsWith('.tmp')) controller.abort()
    })
    try {
      await assert.rejects(
        context.savePlan(
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
    assert.equal(
      context.events.filter((event) => event.event.type === 'plan_state_changed' && event.event.reason === 'saved')
        .length,
      1,
    )
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
    await context.children.get(child.sessionKey)!.finish('首轮结果')
    await context.until(
      async () =>
        (await context.bridge.getAgents('root-key')).find((entry) => entry.agentId === child.agentId)!.status ===
        'completed',
    )
    await assert.rejects(
      context.savePlan(
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
    const directory = path.join(context.plansDataDir, sessionId)
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
      assert.equal(
        context.events.filter((event) => event.event.type === 'plan_state_changed' && event.event.reason === 'saved')
          .length,
        0,
      )
      assert.equal((await context.bridge.snapshot('root-key')).agent.status, 'stopped')
    } finally {
      watcher.close()
    }
  } finally {
    await context.cleanup()
  }
})

test('计划引用隔离会话、拒绝旧修订，跨轮调整沿用同一文档', async () => {
  const context = await setup()
  const signal = new AbortController().signal
  try {
    await context.begin('plan')
    const first = await context.savePlan(context.root.session, { title: '初稿', markdown: '# 初稿' }, signal)
    const reference = { id: first.id, revision: first.revision }
    assert.equal((await context.bridge.resolvePlan(context.root.session, reference, signal)).markdown, '# 初稿')
    await assert.rejects(
      context.bridge.resolvePlan(context.root.session, { ...reference, revision: 3 }, signal),
      /新修订/,
    )
    await assert.rejects(
      context.bridge.resolvePlan(context.root.session, { id: 'other-session-plan', revision: 1 }, signal),
      /不存在/,
    )
    await context.begin('plan')
    const revised = await context.savePlan(
      context.root.session,
      { title: '调整稿', markdown: '# 调整稿', reference },
      signal,
    )
    assert.equal(revised.id, first.id)
    assert.equal(revised.revision, 2)
    await assert.rejects(context.bridge.resolvePlan(context.root.session, reference, signal), /新修订/)
  } finally {
    await context.cleanup()
  }
})
