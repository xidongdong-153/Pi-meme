import assert from 'node:assert/strict'
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DesktopBridge, DesktopEvent, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { useAppSession } from '../src/session/use-app-session'

afterEach(cleanup)

test('只有当前会话的新修订保存事件打开计划栏，快照、重复和迟到事件不抢标签', async () => {
  const document: PlanDocument = {
    id: 'plan',
    sessionId: 'main',
    runId: 'run',
    title: '计划',
    markdown: '# 最新正文',
    revision: 2,
    updatedAt: '2026-10-10T00:00:00Z',
  }
  const snapshot: Snapshot = {
    connection: { generation: 2, sessionKey: 'main', cwd: '/tmp/project', status: 'ready' },
    state: {
      mode: 'plan',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      pendingMessageCount: 0,
    },
    messages: [],
    models: [],
    planDocuments: [document],
  }
  let emit!: (event: DesktopEvent) => void
  const opened: PlanDocument[] = []
  let finishSelection!: (result: SessionSelectionResult) => void
  const bridge = {
    getConnection: async () => snapshot.connection,
    getSnapshot: async () => snapshot,
    onConnection: () => () => {},
    onError: () => () => {},
    onEvent: (callback: typeof emit) => {
      emit = callback
      return () => {}
    },
    newSession: () =>
      new Promise<SessionSelectionResult>((resolve) => {
        finishSelection = resolve
      }),
  } as unknown as DesktopBridge
  const { result } = renderHook(() =>
    useAppSession(bridge, {
      chatEnabled: false,
      workspaceEnabled: false,
      onPlanSaved: (value) => opened.push(value),
    }),
  )
  await waitFor(() => expect(result.current.connection.sessionKey).toBe('main'))
  assert.equal(opened.length, 0, '快照恢复不打开计划栏')
  const record = (revision: number, overrides: Partial<DesktopEvent> = {}): DesktopEvent => ({
    generation: 2,
    sessionKey: 'main',
    event: { type: 'plan_saved', document: { ...document, revision, markdown: `修订${revision}` } },
    ...overrides,
  })
  act(() => emit(record(2)))
  act(() => emit(record(1)))
  act(() => emit(record(3, { generation: 1 })))
  act(() => emit(record(3, { sessionKey: 'background' })))
  assert.equal(opened.length, 0, '重复、旧修订、旧代次和后台保存不抢标签')
  assert.equal(result.current.chatStream.getSnapshot().planDocuments?.[0].markdown, document.markdown)
  act(() => emit(record(3)))
  assert.deepEqual(
    opened.map((value) => value.revision),
    [3],
  )
  act(() => emit(record(3)))
  act(() => emit(record(2)))
  assert.deepEqual(
    opened.map((value) => value.revision),
    [3],
  )
  assert.equal(result.current.chatStream.getSnapshot().planDocuments?.[0].markdown, '修订3')
  let selecting!: Promise<unknown>
  act(() => {
    selecting = result.current.newSession()
  })
  act(() => emit(record(4)))
  assert.deepEqual(
    opened.map((value) => value.revision),
    [3],
    '切换事务期间不抢标签',
  )
  assert.equal(result.current.chatStream.getSnapshot().planDocuments?.[0].revision, 3)
  await act(async () => {
    finishSelection({ cancelled: true })
    await selecting
  })
})

test('历史编辑预览恢复编辑点之前的方案，取消后恢复当前方案，清空拒绝迟到事件', async () => {
  const document: PlanDocument = {
    id: 'plan',
    sessionId: 'main',
    runId: 'run',
    revision: 2,
    title: '当前方案',
    markdown: '# 当前',
    updatedAt: '2026-10-26T00:00:00Z',
  }
  const original = { ...document, revision: 1, title: '原方案', markdown: '# 原方案' }
  const user = (id: string, timestamp: number) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text: '调整' }],
    timestamp,
    sourceEntry: { id, type: 'message' as const, revision: id },
  })
  const first = user('first-user', 1000)
  const adjustment = user('adjustment', 2000)
  const snapshot: Snapshot = {
    connection: { generation: 1, sessionKey: 'main', cwd: '/tmp/project', status: 'ready' },
    state: {
      mode: 'plan',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      pendingMessageCount: 0,
    },
    messages: [first, adjustment],
    models: [],
    planDocuments: [document],
    planState: { sessionId: 'main', revision: 2, document, sourceEntryId: 'second-save' },
    planCheckpoints: [
      { document: original, sourceEntryId: 'first-save' },
      { document, sourceEntryId: 'second-save' },
    ],
    sessionEntries: {
      leafId: 'second-save',
      entries: [
        { id: 'first-user', parentId: null, type: 'message', timestamp: '2026-10-26T00:00:00Z' },
        { id: 'first-save', parentId: 'first-user', type: 'message', timestamp: '2026-10-26T00:00:01Z' },
        { id: 'adjustment', parentId: 'first-save', type: 'message', timestamp: '2026-10-26T00:00:02Z' },
        { id: 'second-save', parentId: 'adjustment', type: 'message', timestamp: '2026-10-26T00:00:03Z' },
      ],
    },
  }
  let emit!: (record: DesktopEvent) => void
  const bridge = {
    getConnection: async () => snapshot.connection,
    getSnapshot: async () => snapshot,
    onConnection: () => () => {},
    onError: () => () => {},
    onEvent: (callback: typeof emit) => {
      emit = callback
      return () => {}
    },
  } as unknown as DesktopBridge
  const { result } = renderHook(() => useAppSession(bridge, { chatEnabled: false, workspaceEnabled: false }))
  await waitFor(() => expect(result.current.planDocuments[0]?.title).toBe('当前方案'))
  act(() => result.current.editMessage(adjustment))
  expect(result.current.planDocuments[0]?.markdown).toBe('# 原方案')
  await act(() => result.current.cancelEdit())
  expect(result.current.planDocuments[0]?.markdown).toBe('# 当前')
  act(() => result.current.editMessage(first))
  expect(result.current.planDocuments).toEqual([])
  await act(() => result.current.cancelEdit())
  const state = { sessionId: 'main', revision: 3 }
  act(() =>
    emit({ generation: 1, sessionKey: 'main', event: { type: 'plan_state_changed', state, reason: 'restored' } }),
  )
  act(() =>
    emit({
      generation: 1,
      sessionKey: 'main',
      event: { type: 'plan_state_changed', state: snapshot.planState!, reason: 'saved' },
    }),
  )
  expect(result.current.planDocuments).toEqual([])
})
