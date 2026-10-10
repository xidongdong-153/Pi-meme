import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { groupSessions, mergeRuntimeSessions } from '../src/server/session-groups'
import { SessionService } from '../src/server/session-service'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

test('SessionService 在临时目录扫描摘要、项目与置顶，并保留部分读取行为', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-desktop-sessions-'))
  const projectDirectory = path.join(directory, '--test-project--')
  const sessionFile = path.join(projectDirectory, '2026-09-28_test-session.jsonl')
  await mkdir(projectDirectory)
  await writeFile(
    sessionFile,
    [
      { type: 'session', id: 'test-session', timestamp: '2026-09-28T00:00:00.000Z', cwd: '/test/project', version: 3 },
      { type: 'session_info', id: 'name', parentId: null, timestamp: '2026-09-28T00:00:00.000Z', name: '测试会话' },
      {
        type: 'message',
        id: 'first',
        parentId: 'name',
        timestamp: '2026-09-28T00:00:01.000Z',
        message: userMessage('第一条消息', 1),
      },
      {
        type: 'message',
        id: 'second',
        parentId: 'first',
        timestamp: '2026-09-28T00:00:02.000Z',
        message: userMessage('第二条消息', 2),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  try {
    const service = new SessionService(directory)
    const snapshot = await service.getSnapshot({ sessionId: 'test-session', sessionFile }, [sessionFile])
    assert.equal(snapshot.recents.length, 1)
    assert.equal(snapshot.recents[0].name, '测试会话')
    assert.equal(snapshot.recents[0].firstMessage, '第一条消息')
    assert.equal(snapshot.recents[0].messageCount, 2)
    assert.equal(snapshot.recents[0].created, '2026-09-28T00:00:00.000Z')
    assert.equal(typeof snapshot.recents[0].modified, 'string')
    assert.equal(snapshot.projects[0].cwd, '/test/project')
    assert.equal(snapshot.projects[0].name, 'project')
    assert.equal(snapshot.projects[0].sessionCount, 1)
    assert.deepEqual(snapshot.pinnedPaths, [sessionFile])
    assert.equal(snapshot.activeSessionId, 'test-session')
    const cached = await service.getSnapshot({ sessionId: 'other' }, [])
    assert.equal(cached.recents, snapshot.recents)
    assert.equal(cached.activeSessionId, 'other')
    assert.deepEqual(cached.pinnedPaths, [])
    service.invalidate()
    assert.equal((await service.getSnapshot()).recents.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readSessionHistory 与 prefetchSessionHistory 能够快速提取历史消息、标题与模型', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-desktop-history-'))
  const sessionFile = path.join(directory, 'test.jsonl')
  await writeFile(
    sessionFile,
    [
      { type: 'session', id: 's1', timestamp: '2026-09-28T00:00:00.000Z', cwd: '/test', version: 3 },
      {
        type: 'model_change',
        id: 'm1',
        parentId: null,
        timestamp: '2026-09-28T00:00:00.000Z',
        provider: 'test-p',
        modelId: 'test-m',
      },
      { type: 'session_info', id: 'n1', parentId: 'm1', timestamp: '2026-09-28T00:00:00.000Z', name: '极速会话' },
      {
        type: 'message',
        id: 'msg-1',
        parentId: 'n1',
        timestamp: '2026-09-28T00:00:01.000Z',
        message: userMessage('测试快速读取', 1),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  try {
    const { readSessionHistory, prefetchSessionHistory } = await import('../src/server/session-reader')
    await prefetchSessionHistory(sessionFile)
    const result = await readSessionHistory(sessionFile)
    assert.equal(result.sessionName, '极速会话')
    assert.deepEqual(result.model, { provider: 'test-p', id: 'test-m' })
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].role, 'user')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('会话文件追加消息后，即使目录时间未变化也重新读取摘要', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-refresh-'))
  const projectDirectory = path.join(directory, '--project--')
  const sessionFile = path.join(projectDirectory, 'session.jsonl')
  await mkdir(projectDirectory)
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: 'session', id: 's1', cwd: '/project', timestamp: '2026-09-29T00:00:00Z' })}\n`,
  )
  try {
    const service = new SessionService(directory)
    assert.equal((await service.getSnapshot()).recents.length, 0)
    await appendFile(sessionFile, `${JSON.stringify({ type: 'message', message: userMessage('新追加消息', 1) })}\n`)
    service.invalidate()
    assert.equal((await service.getSnapshot()).recents[0].firstMessage, '新追加消息')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('合并运行会话和磁盘历史，未落盘的新会话立即出现在项目中', () => {
  const base = {
    id: 'saved',
    path: '/saved.jsonl',
    cwd: '/project',
    name: '已保存标题',
    created: '2026-09-29T00:00:00Z',
    modified: '2026-09-29T00:00:00Z',
    messageCount: 1,
  }
  const snapshot = mergeRuntimeSessions(
    {
      recents: [base],
      projects: [{ cwd: '/project', name: 'project', sessionCount: 1, lastModified: base.modified, sessions: [base] }],
      pinnedPaths: [],
    },
    [
      { ...base, name: undefined, running: true },
      { ...base, id: 'new', path: 'runtime:new', cwd: '/other', running: true },
    ],
  )
  assert.equal(snapshot.recents.length, 2)
  assert.equal(snapshot.recents.find((session) => session.path === base.path)?.name, '已保存标题')
  assert.equal(snapshot.projects.find((project) => project.cwd === '/other')?.sessions[0].running, true)
  assert.equal(snapshot.projects.find((project) => project.cwd === '/project')?.sessionCount, 1)
})

test('项目内新会话按创建时间排在首位，首次完成后按完成时间排序', () => {
  const saved = {
    id: 'saved',
    path: '/saved.jsonl',
    cwd: '/project',
    created: '2026-09-29T00:00:00Z',
    modified: '2026-09-29T01:00:00Z',
    completedAt: '2026-09-29T01:00:00Z',
    messageCount: 2,
  }
  const older = { ...saved, id: 'older', path: '/older.jsonl', completedAt: '2026-09-29T00:30:00Z' }
  const fresh = {
    ...saved,
    id: 'new',
    path: 'runtime:new',
    created: '2026-09-29T02:00:00Z',
    completedAt: null,
    messageCount: 1,
    running: true,
  }
  const files = [saved, older].map((session) => ({ path: session.path, mtime: Date.parse(session.modified) }))
  const grouped = groupSessions(
    files,
    new Map([['--project--', files]]),
    new Map([saved, older].map((session) => [session.path, session])),
    '/home',
  )
  const merged = mergeRuntimeSessions({ ...grouped, pinnedPaths: [] }, [fresh])
  assert.deepEqual(
    merged.projects[0].sessions.map((session) => session.id),
    ['new', 'saved', 'older'],
  )
  assert.deepEqual(
    merged.recents.map((session) => session.id),
    ['saved', 'older', 'new'],
  )

  const diskFresh = { ...fresh, path: '/new.jsonl', running: undefined }
  const diskFiles = [...files, { path: diskFresh.path, mtime: Date.parse(diskFresh.created) }]
  const refreshed = groupSessions(
    diskFiles,
    new Map([['--project--', diskFiles]]),
    new Map([saved, older, diskFresh].map((session) => [session.path, session])),
    '/home',
  )
  assert.deepEqual(
    refreshed.projects[0].sessions.map((session) => session.id),
    ['new', 'saved', 'older'],
  )

  const completed = mergeRuntimeSessions(merged, [{ ...fresh, completedAt: '2026-09-29T03:00:00Z', running: false }])
  assert.deepEqual(
    completed.projects[0].sessions.map((session) => session.id),
    ['new', 'saved', 'older'],
  )
  const nextTurn = mergeRuntimeSessions(completed, [{ ...saved, modified: '2026-09-29T04:00:00Z', running: true }])
  assert.deepEqual(
    nextTurn.projects[0].sessions.map((session) => session.id),
    ['new', 'saved', 'older'],
  )
  const nextCompletion = mergeRuntimeSessions(nextTurn, [
    { ...saved, completedAt: '2026-09-29T05:00:00Z', running: false },
  ])
  assert.deepEqual(
    nextCompletion.projects[0].sessions.map((session) => session.id),
    ['saved', 'new', 'older'],
  )
})

test('最近会话和项目按完成时间排序，新用户消息修改文件时间也不改变顺序', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-completed-order-'))
  const files: string[] = []
  try {
    for (const [id, completedAt] of [
      ['a', '2026-09-29T01:00:00Z'],
      ['b', '2026-09-29T02:00:00Z'],
    ]) {
      const projectDirectory = path.join(directory, id)
      await mkdir(projectDirectory)
      const file = path.join(projectDirectory, `${id}.jsonl`)
      files.push(file)
      await writeFile(
        file,
        `${[
          { type: 'session', id, cwd: `/project-${id}`, timestamp: '2026-09-29T00:00:00Z' },
          { type: 'message', timestamp: '2026-09-29T00:00:00Z', message: userMessage(id, 1) },
          { type: 'message', timestamp: completedAt, message: assistantMessage('完成', 2) },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n')}\n`,
      )
    }
    const service = new SessionService(directory)
    assert.deepEqual(
      (await service.getSnapshot()).recents.map((session) => session.id),
      ['b', 'a'],
    )
    await appendFile(
      files[0],
      `${JSON.stringify({ type: 'message', timestamp: '2026-09-29T03:00:00Z', message: userMessage('下一轮仍在运行', 3) })}\n`,
    )
    service.invalidate()
    const pending = await service.getSnapshot()
    assert.deepEqual(
      pending.recents.map((session) => session.id),
      ['b', 'a'],
    )
    assert.deepEqual(
      pending.projects.map((project) => project.cwd),
      ['/project-b', '/project-a'],
    )
    const running = mergeRuntimeSessions(pending, [{ ...pending.recents[1], running: true }])
    assert.deepEqual(
      running.projects.map((project) => project.cwd),
      ['/project-b', '/project-a'],
    )
    const newSession = mergeRuntimeSessions(pending, [
      { ...pending.recents[1], id: 'new', path: 'runtime:new', cwd: '/project-new', completedAt: null, running: true },
    ])
    assert.deepEqual(
      newSession.projects.map((project) => project.cwd),
      ['/project-b', '/project-a', '/project-new'],
    )
    await appendFile(
      files[0],
      `${JSON.stringify({ type: 'message', timestamp: '2026-09-29T04:00:00Z', message: assistantMessage('新一轮完成', 4) })}\n`,
    )
    service.invalidate()
    const completed = await service.getSnapshot()
    assert.deepEqual(
      completed.recents.map((session) => session.id),
      ['a', 'b'],
    )
    assert.deepEqual(
      completed.projects.map((project) => project.cwd),
      ['/project-a', '/project-b'],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('摘要读取后置标题、标题清空和全部消息，删除文件后清理列表', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-summary-regression-'))
  const project = path.join(directory, '--project--')
  const file = path.join(project, 'session.jsonl')
  await mkdir(project)
  const entries = [
    { type: 'session', id: 'saved', version: 3, cwd: project, timestamp: '2026-09-29T00:00:00Z' },
    { type: 'message', timestamp: '2026-09-29T00:00:01Z', message: userMessage('问题', 1) },
    { type: 'message', timestamp: '2026-09-29T00:00:02Z', message: assistantMessage('答案', 2) },
    { type: 'session_info', name: '后置标题' },
  ]
  try {
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n'))
    const service = new SessionService(directory)
    const first = await service.getSnapshot()
    assert.equal(first.recents[0].name, '后置标题')
    assert.equal(first.recents[0].messageCount, 2)
    await appendFile(file, '\n{"type":"session_info","name":""}')
    service.invalidate()
    assert.equal((await service.getSnapshot()).recents[0].name, undefined)
    await rm(file)
    service.invalidate()
    assert.equal((await service.getSnapshot()).recents.length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('文件时间相同但大小变化时重新读取，扫描中的失效不恢复旧缓存', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-summary-cache-'))
  const project = path.join(directory, '--project--')
  const file = path.join(project, 'session.jsonl')
  await mkdir(project)
  try {
    await writeFile(
      file,
      [
        { type: 'session', id: 'saved', version: 3, cwd: project, timestamp: '2026-09-29T00:00:00Z' },
        { type: 'message', timestamp: '2026-09-29T00:00:01Z', message: userMessage('问题', 1) },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    const time = new Date('2026-09-29T00:00:00Z')
    await utimes(file, time, time)
    const service = new SessionService(directory)
    const firstRead = service.getSnapshot()
    service.invalidate()
    const first = await firstRead
    const second = await service.getSnapshot()
    assert.notEqual(first.recents, second.recents)
    const before = await stat(file)
    await appendFile(file, '\n{"type":"session_info","name":"大小变化后的标题"}')
    await utimes(file, time, time)
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs)
    service.invalidate()
    assert.equal((await service.getSnapshot()).recents[0].name, '大小变化后的标题')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
