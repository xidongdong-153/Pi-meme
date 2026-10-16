import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { ComposerToolbar, type ComposerToolbarProps } from '../src/ui/composer/composer-toolbar'
import { ComposerAttachments } from '../src/ui/composer/composer-attachments'
import { ComposerQueues } from '../src/ui/composer/composer-queues'
import { applyEvent, emptyChat, fromSnapshot, restoreSnapshot } from '../src/ui/model/state'
import { queuedDraft } from '../src/ui/composer/restore-queued-input'

const toolbar: ComposerToolbarProps = {
  running: false,
  disabled: false,
  draft: '',
  hasAttachments: false,
  queueMode: 'followUp',
  onQueueMode: () => {},
  onSteeringMode: () => {},
  onFollowUpMode: () => {},
  onStop: () => {},
  model: null,
  access: null,
  contextUsage: null,
  editing: false,
}
const input = { id: 'q1', text: '后续消息', mode: 'default' as const }
function markup(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element))
}

test('主按钮在发送、排队、暂停、继续和保存之间切换，始终只有一个蓝色操作按钮', () => {
  const cases = [
    [{ draft: '正文' }, '发送消息', 'lucide-arrow-up'],
    [{ running: true, draft: '正文' }, '发送排队任务', 'lucide-corner-down-left'],
    [{ running: true }, '暂停当前任务', 'lucide-square'],
    [{ running: true, paused: true }, '继续当前任务', 'lucide-play'],
    [{ paused: true }, '继续当前任务', 'lucide-play'],
    [{ paused: true, hasAttachments: true }, '发送排队任务', 'lucide-corner-down-left'],
    [{ running: true, draft: '修改', editingQueue: true }, '保存排队消息', 'lucide-arrow-up'],
  ] as const
  for (const [props, label, icon] of cases) {
    const html = markup(createElement(ComposerToolbar, { ...toolbar, ...props }))
    assert.equal((html.match(/bg-\[#2f6bca\]/g) ?? []).length, 1)
    assert.match(html, new RegExp(`aria-label="${label}"`))
    assert.match(html, new RegExp(icon))
    assert.doesNotMatch(html, /运行模式|bg-destructive|停止当前任务/)
  }
})

test('有排队消息时顶栏包含逐条操作和紧凑图片，暂停时提供继续', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'YWJj' }
  const html = markup(
    createElement(ComposerQueues, {
      queues: { steering: [], followUp: [{ ...input, images: [image, image, image] }] },
      disabled: false,
      paused: true,
    }),
  )
  assert.match(html, /mx-3 -mb-2/)
  assert.match(html, /由于你中断了当前响应，队列已暂停/)
  assert.match(html, /aria-label="继续队列"/)
  assert.match(html, /aria-label="引导"/)
  assert.match(html, /aria-label="删除排队消息"/)
  assert.match(html, /aria-label="排队消息更多操作"/)
  assert.equal((html.match(/alt="排队图片"/g) ?? []).length, 1)
  assert.match(html, />\+2</)
  assert.doesNotMatch(html, /清空|关闭排队|整批|逐项|侧边聊天/)
})

test('队列为空时不显示队列顶栏和暂停横幅', () => {
  for (const paused of [false, true]) {
    const html = markup(
      createElement(ComposerQueues, { queues: { steering: [], followUp: [] }, paused, disabled: false }),
    )
    assert.equal(html, '')
  }
})

test('编辑占位和不同模式的排队项禁止引导', () => {
  for (const entry of [
    { ...input, editing: true },
    { ...input, mode: 'plan' as const },
  ]) {
    const html = markup(
      createElement(ComposerQueues, {
        queues: { steering: [], followUp: [entry] },
        activeMode: 'default',
        disabled: false,
      }),
    )
    assert.match(html, /aria-label="引导" disabled=""/)
  }
})

test('已引导消息显示等待工具结束，不再提供引导、删除或编辑操作', () => {
  const html = markup(
    createElement(ComposerQueues, {
      queues: { steering: [{ ...input, submitted: true }], followUp: [] },
      activeMode: 'default',
      disabled: false,
    }),
  )
  assert.match(html, /后续消息/)
  assert.match(html, /已引导，等待当前工具结束/)
  assert.doesNotMatch(html, /aria-label="引导"|aria-label="删除排队消息"|aria-label="排队消息更多操作"/)
})

test('暂停事件按修订投影，agent_settled保留队列，重连恢复暂停和队列', () => {
  const queued = applyEvent(emptyChat, { type: 'queue_update', steering: [], followUp: [input] })
  const paused = applyEvent(queued, { type: 'pause_update', isPaused: true, queuePaused: true, revision: 2 })
  const settled = applyEvent(paused, { type: 'agent_settled' })
  assert.deepEqual(settled.followUp, [input])
  assert.equal(settled.paused, true)
  assert.equal(applyEvent(settled, { type: 'pause_update', isPaused: false, queuePaused: false, revision: 1 }), settled)
  const snapshot = {
    connection: { generation: 1 },
    state: { isStreaming: true, isPaused: true, queuePaused: true, pauseRevision: 2 },
    messages: [],
    models: [],
    events: [{ generation: 1, event: { type: 'queue_update', steering: [], followUp: [input] } }],
  } as unknown as Snapshot
  const restored = restoreSnapshot(snapshot, null)
  assert.equal(restored.running, true)
  assert.equal(restored.paused, true)
  assert.deepEqual(restored.followUp, [input])
})

test('队列编辑恢复全部图片且使用独立附件身份', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'YWJj' }
  const restored = queuedDraft({ ...input, mode: 'plan', images: [image, image, image] }, [])
  assert.equal(restored.mode, 'plan')
  assert.equal(restored.draft, input.text)
  assert.equal(restored.attachments.length, 3)
  assert.equal(new Set(restored.attachments.map(({ id }) => id)).size, 3)
})

test('空的队列编辑只能禁用保存，不得变成暂停或继续', () => {
  for (const paused of [false, true]) {
    const html = markup(createElement(ComposerToolbar, { ...toolbar, running: true, paused, editingQueue: true }))
    assert.match(html, /type="submit" disabled="" aria-label="保存排队消息"/)
    assert.doesNotMatch(html, /lucide-play|lucide-square/)
  }
})

test('自动FIFO新轮次使用当前树根模式，settled和idle清除，快照优先SDK', () => {
  const root = { agentId: 'root', rootAgentId: 'root', depth: 0, status: 'running', mode: 'plan' } as AgentSummary
  const child = { ...root, agentId: 'child', depth: 1, mode: 'default' as const }
  let state = applyEvent(
    { ...emptyChat, running: true, activeMode: 'default' },
    { type: 'agents_update', agents: [child, root] },
  )
  assert.equal(state.activeMode, 'plan')
  state = applyEvent(state, { type: 'agent_settled' })
  assert.equal(state.activeMode, undefined)
  for (const status of ['completed', 'failed', 'interrupted', 'stopped', 'idle'] as const) {
    assert.equal(
      applyEvent({ ...state, activeMode: 'default' }, { type: 'agents_update', agents: [{ ...root, status }] })
        .activeMode,
      undefined,
    )
  }
  const snapshot = {
    connection: {},
    state: { isStreaming: true, activeMode: 'default' },
    agents: [root],
    messages: [],
    models: [],
  } as unknown as Snapshot
  assert.equal(fromSnapshot(snapshot).activeMode, 'default')
})

test('提交队列编辑期间禁用图片移除按钮', () => {
  const html = markup(
    createElement(ComposerAttachments, {
      disabled: true,
      attachments: [{ id: 'image', type: 'image', mimeType: 'image/png', data: 'YWJj' }],
      onRemoveImage: () => {},
    }),
  )
  assert.match(html, /type="button" disabled="" aria-label="移除图片"/)
})
