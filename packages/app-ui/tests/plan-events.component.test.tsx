import assert from 'node:assert/strict'
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DesktopBridge, DesktopEvent, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { useAppSession } from '../src/use-app-session'

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
