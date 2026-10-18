import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { DesktopBridge, DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { assistantMessage, sessionState, userMessage } from '../../../tests/fixtures/messages.mjs'
import { SubagentsPanel } from '../src/panels/subagents-panel'

afterEach(cleanup)

function fixture(overrides: Partial<AgentSummary> = {}) {
  const agent: AgentSummary = {
    agentId: 'child',
    rootAgentId: 'root',
    parentAgentId: 'root',
    rootSessionKey: 'main',
    sessionKey: 'child-session',
    name: '检查布局',
    taskPath: '/root/check-layout',
    depth: 1,
    rootTaskId: 'task',
    epoch: 1,
    executionGeneration: 1,
    status: 'completed',
    cwd: '/tmp/project',
    accessMode: 'workspace-write',
    mode: 'default',
    model: { provider: 'fake', id: 'test-model', name: '本地测试模型' },
    thinkingLevel: 'high',
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
  const snapshot: Snapshot = {
    agent,
    connection: { generation: 1, sessionKey: agent.sessionKey, cwd: agent.cwd, status: 'idle' },
    state: { ...sessionState(), mode: 'default' },
    messages: [userMessage('父代理派发的任务', 1000), assistantMessage('子代理的结论', 5000)],
    models: [],
    eventSequence: 1,
  }
  const listeners = new Set<(event: DesktopEvent) => void>()
  const getAgentSnapshot = vi.fn(async () => snapshot)
  const bridge = {
    getAgents: vi.fn(async () => [agent]),
    getAgentSnapshot,
    onEvent: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection: () => () => {},
  } as unknown as DesktopBridge
  render(
    <TooltipProvider>
      <SubagentsPanel bridge={bridge} sessionKey="main" />
    </TooltipProvider>,
  )
  return {
    agent,
    snapshot,
    getAgentSnapshot,
    emit: (event: DesktopEvent) => listeners.forEach((listener) => listener(event)),
  }
}

test('详情隐藏派发消息和路径，模型及强度随事件更新，图标按钮可返回列表', async () => {
  const user = userEvent.setup()
  const { agent, snapshot, getAgentSnapshot, emit } = fixture()
  const original = structuredClone(snapshot)
  await user.click(await screen.findByRole('button', { name: /检查布局/ }))
  expect(await screen.findByText('子代理的结论')).toBeVisible()
  expect(screen.queryByText('父代理派发的任务')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('对话索引')).not.toBeInTheDocument()
  expect(screen.queryByText('/root/check-layout')).not.toBeInTheDocument()
  expect(screen.getByText('本地测试模型')).toHaveAttribute('title', '本地测试模型')
  expect(screen.getByTitle('思考强度：高')).toBeVisible()
  expect(screen.getByText('检查布局')).toHaveAttribute('title', '检查布局 · 已完成')

  act(() => {
    emit({
      generation: 1,
      sessionKey: 'main',
      event: {
        type: 'agents_update',
        agents: [{ ...agent, isPaused: true, model: { provider: 'fake', id: 'next-model' }, thinkingLevel: 'off' }],
      },
    })
  })
  expect(screen.getByText('next-model')).toBeVisible()
  expect(screen.getByTitle('思考强度：关')).toBeVisible()
  expect(screen.getByText('检查布局')).toHaveAttribute('title', '检查布局 · 已暂停')
  expect(getAgentSnapshot).toHaveBeenCalledExactlyOnceWith('child')
  expect(snapshot).toEqual(original)

  const back = screen.getByRole('button', { name: '返回子代理列表' })
  expect(back.textContent).toBe('')
  await user.click(back)
  expect(screen.getByRole('region', { name: '已结束子代理' })).toBeVisible()
  expect(screen.queryByText('子代理的结论')).not.toBeInTheDocument()
})

test('缺少子代理模型与强度时明确显示未知信息', async () => {
  const user = userEvent.setup()
  fixture({ model: undefined, thinkingLevel: undefined })
  await user.click(await screen.findByRole('button', { name: /检查布局/ }))
  expect(await screen.findByText('子代理的结论')).toBeVisible()
  expect(screen.getByText('模型未知')).toBeVisible()
  expect(screen.getByTitle('思考强度：强度未知')).toBeVisible()
})
