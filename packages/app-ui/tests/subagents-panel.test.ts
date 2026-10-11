import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSummary, AgentStatus } from '@pi-meme/contracts/collaboration'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import { agentElapsed, agentFinishedAgo, agentRunning, orderAgents, SubagentsPanel } from '../src/subagents-panel'

const now = Date.parse('2026-10-11T12:00:00Z')
function agent(id: string, status: AgentStatus = 'completed', overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId: id,
    rootAgentId: 'root',
    parentAgentId: 'root',
    rootSessionKey: 'main',
    sessionKey: `session-${id}`,
    name: id,
    taskPath: `/root/${id}`,
    depth: 1,
    rootTaskId: 'task',
    epoch: 1,
    executionGeneration: 1,
    status,
    cwd: '/tmp/project',
    accessMode: 'workspace-write',
    mode: 'default',
    runStartedAt: new Date(now - 120000).toISOString(),
    runCompletedAt: status === 'completed' ? new Date(now - 30000).toISOString() : undefined,
    updatedAt: new Date(now).toISOString(),
    ...overrides,
  }
}

test('没有任务时仍保留两个分组和明确的空列表说明', () => {
  const markup = renderToStaticMarkup(createElement(SubagentsPanel, { bridge: {} as DesktopBridge }))
  assert.match(markup, /aria-label="运行中子代理"/)
  assert.match(markup, /已开启 · 0/)
  assert.match(markup, /没有已开启的子代理/)
  assert.match(markup, /aria-label="已结束子代理"/)
  assert.match(markup, /已结束 · 0/)
  assert.match(markup, /没有已结束的子代理/)
  assert.doesNotMatch(markup, /animate-spin/)
})

test('空闲、等待和暂停的可继续身份留在已开启分组，终止身份进入已结束分组', () => {
  const open: AgentStatus[] = ['idle', 'starting', 'running', 'waiting_children', 'waiting_input']
  for (const status of open) assert.equal(agentRunning(agent(status, status, { isPaused: true })), true)
  for (const status of ['completed', 'failed', 'interrupted', 'stopped'] as const)
    assert.equal(agentRunning(agent(status, status)), false)
  const entries = [agent('running', 'running'), agent('idle', 'idle'), agent('done')]
  assert.deepEqual(
    orderAgents(entries, true).map((entry) => entry.agentId),
    ['idle', 'running'],
  )
  assert.deepEqual(
    orderAgents(entries, false).map((entry) => entry.agentId),
    ['done'],
  )
})

test('结束列表按最新完成分支排序，并将父子连续排列，保留输入次序', () => {
  const parent = agent('parent', 'completed', { runCompletedAt: new Date(now - 120000).toISOString() })
  const child = agent('child', 'completed', {
    parentAgentId: 'parent',
    taskPath: '/root/parent/child',
    depth: 2,
    runCompletedAt: new Date(now - 10000).toISOString(),
  })
  const other = agent('other', 'completed', { runCompletedAt: new Date(now - 30000).toISOString() })
  const entries = [child, other, parent]
  assert.deepEqual(
    orderAgents(entries, false).map((entry) => entry.agentId),
    ['parent', 'child', 'other'],
  )
  assert.deepEqual(entries, [child, other, parent])
})

test('已结束子任务的父代理仍开启时，子任务不会从结束列表丢失', () => {
  const entries = [agent('parent', 'running'), agent('child', 'completed', { parentAgentId: 'parent', depth: 2 })]
  assert.deepEqual(
    orderAgents(entries, false).map((entry) => entry.agentId),
    ['child'],
  )
})

test('结束时间采用本轮完成时间，缺少完成时间时使用最后更新时间', () => {
  const elapsed = (seconds: number) =>
    agentFinishedAgo(agent('done', 'completed', { runCompletedAt: new Date(now - seconds * 1000).toISOString() }), now)
  assert.equal(elapsed(-10), '刚刚')
  assert.equal(elapsed(59), '刚刚')
  assert.equal(elapsed(60), '1 分前')
  assert.equal(elapsed(3600), '1 小时前')
  assert.equal(elapsed(86400), '1 天前')
  assert.equal(
    agentFinishedAgo(agent('failed', 'failed', { updatedAt: new Date(now - 180000).toISOString() }), now),
    '3 分前',
  )
})

test('总用时在结束后固定，不把完成后等待算入本轮运行时间', () => {
  const completed = agent('done')
  assert.equal(agentElapsed(completed, now), '1 分 30 秒')
  assert.equal(agentElapsed(completed, now + 600000), '1 分 30 秒')
  assert.equal(agentElapsed(agent('running', 'running'), now), '2 分 0 秒')
  assert.equal(agentElapsed(agent('idle', 'idle', { runStartedAt: undefined }), now), '尚未运行')
})
