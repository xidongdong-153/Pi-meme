import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopBridge, DesktopEvent, SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { useAppSession } from '../src/use-app-session'

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
  const effects: Array<() => void | (() => void)> = []
  let finishSelection!: (result: SessionSelectionResult) => void
  let session!: ReturnType<typeof useAppSession>
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
  function Capture() {
    // SSR 不执行 effect；捕获真实订阅 effect，手动挂载后发送临时 Bridge 事件。
    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
          H: { useEffect: (effect: () => void | (() => void)) => void }
        }
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    const dispatcher = internals.H
    const original = dispatcher.useEffect
    dispatcher.useEffect = (effect) => {
      effects.push(effect)
    }
    try {
      session = useAppSession(bridge, {
        chatEnabled: false,
        workspaceEnabled: false,
        onPlanSaved: (value) => opened.push(value),
      })
    } finally {
      dispatcher.useEffect = original
    }
    return null
  }
  renderToStaticMarkup(React.createElement(Capture))
  const cleanups = effects.map((effect) => effect())
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(opened.length, 0, '快照恢复不打开计划栏')
    const record = (revision: number, overrides: Partial<DesktopEvent> = {}): DesktopEvent => ({
      generation: 2,
      sessionKey: 'main',
      event: { type: 'plan_saved', document: { ...document, revision, markdown: `修订${revision}` } },
      ...overrides,
    })
    emit(record(2))
    emit(record(1))
    emit(record(3, { generation: 1 }))
    emit(record(3, { sessionKey: 'background' }))
    assert.equal(opened.length, 0, '重复、旧修订、旧代次和后台保存不抢标签')
    assert.equal(session.chatStream.getSnapshot().planDocuments?.[0].markdown, document.markdown)
    emit(record(3))
    assert.deepEqual(
      opened.map((value) => value.revision),
      [3],
    )
    emit(record(3))
    emit(record(2))
    assert.deepEqual(
      opened.map((value) => value.revision),
      [3],
    )
    assert.equal(session.chatStream.getSnapshot().planDocuments?.[0].markdown, '修订3')
    const selecting = session.newSession()
    emit(record(4))
    assert.deepEqual(
      opened.map((value) => value.revision),
      [3],
      '切换事务期间不抢标签',
    )
    assert.equal(session.chatStream.getSnapshot().planDocuments?.[0].revision, 3)
    finishSelection({ cancelled: true })
    await selecting
  } finally {
    cleanups.reverse().forEach((cleanup) => cleanup?.())
  }
})
