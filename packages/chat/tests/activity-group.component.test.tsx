import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'
import { ToolActivityRow } from '../src/ui/conversation/tool-activity-row'
import type { ActivityItem, ChatState } from '../src/ui/model/types'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { Conversation } from '../src/ui/conversation/conversation'
import { ChatStream } from '../src/ui/model/chat-stream'
import { applyEvent, emptyChat } from '../src/ui/model/state'
import type { PiEvent } from '@pi-meme/contracts/pi'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { projectAgentConversation } from '../src/ui/model/agent-collaboration'
import { assistantMessage, streamUpdate, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

afterEach(cleanup)

const items: ActivityItem[] = [
  { id: 'thinking', type: 'thinking', thinking: '检查文件', status: 'success' },
  { id: 'write', type: 'tool', name: 'write', args: { path: 'a.ts' }, result: '文件结果', status: 'success' },
]

test('子代理多轮状态位于工具段之间，全部过程折叠后仍可见且最终回复复制不混入状态', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const statuses = [
    {
      id: 'send',
      afterActivityId: 'send',
      kind: 'feedback' as const,
      status: 'success' as const,
      text: '已向 UI impl 反馈',
    },
    {
      id: 'wait',
      afterActivityId: 'wait',
      kind: 'wait' as const,
      status: 'success' as const,
      text: '已收到 UI impl 的反馈',
    },
    { id: 'report', kind: 'feedback' as const, status: 'success' as const, text: '已向主代理反馈' },
  ]
  const activities: ActivityItem[] = [
    ...items,
    { id: 'send', name: 'send_message', args: { target: 'ui', message: '内部正文' }, status: 'success' },
    { id: 'verify', name: 'bash', args: { command: 'tsc --noEmit' }, status: 'success' },
    { id: 'wait', name: 'wait_agent', args: { targets: ['ui'] }, status: 'success' },
  ]
  const { container } = render(
    <TooltipProvider>
      <AssistantTurnView
        turn={{
          type: 'assistant_turn',
          key: 'agent',
          activities,
          collaboration: statuses,
          finalText: '最终任务报告',
          images: [],
          durationMs: 2000,
          isLive: false,
        }}
      />
    </TooltipProvider>,
  )
  const process = screen.getByRole('button', { name: '工作过程' })
  const rows = screen.getAllByRole('status', { name: '协作状态' })
  const assertRowsVisible = () => {
    for (const row of rows) {
      expect(row).toBeVisible()
      expect(row.closest('[aria-hidden="true"], [inert]')).toBeNull()
    }
  }
  expect(process).toHaveAttribute('aria-expanded', 'false')
  assertRowsVisible()
  expect(container.querySelectorAll('[aria-label="工作过程"]')).toHaveLength(1)
  await user.click(process)
  const disclosures = screen.getAllByRole('button', { name: /^活动详情：/ })
  expect(disclosures).toHaveLength(2)
  const siblings = [...rows[0].parentElement!.children]
  expect(siblings.indexOf(disclosures[0].closest('[id]')!)).toBeLessThan(siblings.indexOf(rows[0]))
  expect(siblings.indexOf(rows[0])).toBeLessThan(siblings.indexOf(disclosures[1].closest('[id]')!))
  await user.click(disclosures[0])
  await user.click(disclosures[0])
  assertRowsVisible()
  await user.click(process)
  assertRowsVisible()
  expect(screen.getByText('最终任务报告')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '复制消息' }))
  expect(writeText).toHaveBeenLastCalledWith('最终任务报告')
})

test('等待行在反馈、暂停和中断时原位更新，完成后停止动画', () => {
  const agent: AgentSummary = {
    agentId: 'api',
    rootAgentId: 'root',
    parentAgentId: 'root',
    name: 'api_impl',
    taskPath: '/root/api_impl',
    depth: 1,
    rootSessionKey: 'main',
    sessionKey: 'api',
    rootTaskId: 'task',
    epoch: 1,
    executionGeneration: 1,
    status: 'running',
    cwd: '/tmp/project',
    accessMode: 'workspace-write',
    mode: 'default',
    updatedAt: new Date().toISOString(),
  }
  const peer = { ...agent, agentId: 'ui', name: 'ui_impl', taskPath: '/root/ui_impl' }
  const call = assistantMessage(
    [{ type: 'toolCall', id: 'wait', name: 'wait_agent', arguments: { targets: ['ui'] } }],
    1000,
  )
  const chat: ChatState = { ...emptyChat, running: true, agents: [agent, peer], messages: [call] }
  const view = (state: ChatState, identity = agent) => {
    const turn = projectAgentConversation(state, identity).find((turn) => turn.type === 'assistant_turn')!
    if (turn.type !== 'assistant_turn') throw new Error('缺少测试轮次')
    return (
      <TooltipProvider>
        <AssistantTurnView turn={turn} />
      </TooltipProvider>
    )
  }
  const { rerender } = render(view(chat))
  const row = screen.getByRole('status', { name: '协作状态' })
  expect(row).toHaveTextContent('正在等待 UI impl 的反馈…')
  expect(row.querySelector('.motion-reduce\\:animate-none')).not.toBeNull()
  rerender(view(chat, { ...agent, isPaused: true }))
  expect(screen.getByRole('status', { name: '协作状态' })).toBe(row)
  expect(row).toHaveTextContent('已暂停等待 UI impl 的反馈…')
  expect(row.querySelector('.motion-reduce\\:animate-none')).toBeNull()
  const received: ChatState = {
    ...chat,
    running: false,
    messages: [
      call,
      {
        ...toolResult('wait', '', 2000),
        toolName: 'wait_agent',
        details: { messages: [{ fromAgentId: 'ui' }], timedOut: false },
      },
      assistantMessage('已完成', 2100),
    ],
  }
  rerender(view(received))
  expect(screen.getByRole('status', { name: '协作状态' })).toBe(row)
  expect(row).toHaveTextContent('已收到 UI impl 的反馈')
  expect(row.querySelector('.motion-reduce\\:animate-none')).toBeNull()
  expect(screen.getByRole('button', { name: '工作过程' })).toHaveAttribute('aria-expanded', 'false')
  expect(row).toBeVisible()
  rerender(view({ ...chat, running: false }, { ...agent, status: 'interrupted' }))
  expect(row).toHaveTextContent('等待 UI impl 的反馈已中断')
  expect(row.querySelector('.motion-reduce\\:animate-none')).toBeNull()
})

test('协作状态仅出现在子代理详情，主聊天继续隐藏内部工具和反馈正文', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const agent: AgentSummary = {
    agentId: 'api',
    rootAgentId: 'root',
    parentAgentId: 'root',
    name: 'api_impl',
    taskPath: '/root/api_impl',
    depth: 1,
    rootSessionKey: 'main',
    sessionKey: 'api',
    rootTaskId: 'task',
    epoch: 1,
    executionGeneration: 1,
    status: 'running',
    cwd: '/tmp/project',
    accessMode: 'workspace-write',
    mode: 'default',
    updatedAt: new Date().toISOString(),
  }
  const chat: ChatState = {
    ...emptyChat,
    running: true,
    messages: [
      assistantMessage(
        [
          {
            type: 'toolCall',
            id: 'send',
            name: 'send_message',
            arguments: { target: 'root', message: '内部协作正文' },
          },
        ],
        1000,
      ),
    ],
  }
  const view = (agentOnly: boolean) => (
    <TooltipProvider>
      <Conversation
        chat={chat}
        agent={agent}
        agentOnly={agentOnly}
        readOnly={agentOnly}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view(false))
  expect(screen.queryByRole('status', { name: '协作状态' })).not.toBeInTheDocument()
  expect(screen.queryByText('内部协作正文')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '工具详情：send_message' })).not.toBeInTheDocument()
  rerender(view(true))
  expect(screen.getByRole('status', { name: '协作状态' })).toHaveTextContent('正在向主代理反馈…')
})

test.each(
  (['read', 'edit', 'apply_patch', 'replace'] as const).flatMap((name) =>
    (['success', 'running', 'error'] as const).map((status) => ({ name, status })),
  ),
)('读取和编辑文件只显示静态摘要，不展开详情：$name / $status', async ({ name, status }) => {
  const user = userEvent.setup()
  const onToggle = vi.fn()
  render(
    <ToolActivityRow
      item={{
        id: name,
        name,
        args: { path: 'src/a.ts' },
        result: {
          content: [{ type: 'text', text: '文件内容或错误原因' }],
          details: { diff: '@@ -1 +1 @@\n-old\n+new' },
        },
        status,
      }}
      open
      onToggle={onToggle}
    />,
  )
  const summary = screen.getByText(/a\.ts/)
  expect(summary).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByText('文件内容或错误原因')).not.toBeInTheDocument()
  expect(screen.queryByTitle('复制输出')).not.toBeInTheDocument()
  expect(screen.queryByText('变更内容 (Diff)')).not.toBeInTheDocument()
  expect(screen.queryByText('old')).not.toBeInTheDocument()
  expect(screen.queryByText('new')).not.toBeInTheDocument()
  if (status === 'error') expect(summary).toHaveTextContent('失败')
  await user.click(summary)
  expect(onToggle).not.toHaveBeenCalled()
})

test('成功查看图片直接显示可预览的小图，不再显示工具输出框和占位文字', async () => {
  const user = userEvent.setup()
  render(
    <ToolActivityRow
      item={{
        id: 'image-read',
        name: 'read',
        args: { path: 'out/screenshots/check.png' },
        result: {
          content: [
            { type: 'text', text: 'Read image file [image/png]' },
            { type: 'image', data: 'YWJj', mimeType: 'image/png' },
          ],
        },
        status: 'success',
        sourceEntry: { id: 'image-entry', type: 'message', revision: 'r1' },
      }}
      open={false}
      onToggle={vi.fn()}
    />,
  )
  const thumbnail = screen.getByRole('button', { name: '预览图片：工具输出图片' })
  expect(screen.getByRole('img', { name: '工具输出图片' })).toHaveAttribute('src', 'data:image/png;base64,YWJj')
  expect(screen.queryByRole('button', { name: '工具详情：read' })).not.toBeInTheDocument()
  expect(screen.queryByText('输出内容')).not.toBeInTheDocument()
  expect(screen.queryByTitle('复制输出')).not.toBeInTheDocument()
  expect(screen.queryByText('Read image file [image/png]')).not.toBeInTheDocument()
  expect(screen.queryByText('[图片]')).not.toBeInTheDocument()
  await user.click(thumbnail)
  expect(await screen.findByRole('dialog', { name: '图片预览' })).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(thumbnail).toHaveFocus()
})

test('图文混合工具保留脚本和文字，图片单独以缩略图显示；失败时保留错误详情', () => {
  const result = {
    content: [
      { type: 'text', text: '执行结果' },
      { type: 'image', data: 'YWJj', mimeType: 'image/png' },
    ],
  }
  const { rerender } = render(
    <ToolActivityRow
      item={{ id: 'mixed', name: 'codemode', args: { code: 'console.log(1)' }, result, status: 'success' }}
      open
      onToggle={vi.fn()}
    />,
  )
  expect(screen.getByLabelText('codemode 执行脚本')).toHaveTextContent('console.log(1)')
  expect(screen.getByText('执行结果')).toBeVisible()
  expect(screen.queryByText('[图片]')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '预览图片：工具输出图片' })).toBeVisible()
  rerender(
    <ToolActivityRow
      item={{ id: 'failed', name: 'read', args: { path: 'check.png' }, result, status: 'error' }}
      open
      onToggle={vi.fn()}
    />,
  )
  expect(screen.getByText('错误详情')).toBeVisible()
  expect(screen.getByText('执行结果')).toBeVisible()
})

test('计时总开关保留运行中的手动选择，完成时收起全部过程并保留最终回复', async () => {
  const user = userEvent.setup()
  const view = (isLive: boolean, activities = items) => (
    <TooltipProvider>
      <AssistantTurnView
        turn={{
          type: 'assistant_turn',
          key: 'turn',
          activities,
          images: [],
          finalText: '最终回复保持可见',
          durationMs: 4000,
          startedAt: Date.now() - 4000,
          isLive,
        }}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view(true))
  const process = screen.getByRole('button', { name: '工作过程' })
  expect(process).toHaveAttribute('aria-expanded', 'true')
  const disclosure = screen.getByRole('button', { name: /^活动详情：/ })
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await user.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  const tool = screen.getByRole('button', { name: '工具详情：write' })
  await user.click(tool)
  rerender(view(true, [...items, { id: 'more', name: 'bash', args: { command: 'git diff' }, status: 'running' }]))
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(tool).toHaveAttribute('aria-expanded', 'true')
  await user.click(process)
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  expect(tool).toHaveAttribute('aria-expanded', 'false')
  expect(disclosure.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(tool.closest('[aria-hidden="true"]')).not.toBeNull()
  rerender(view(true))
  expect(process).toHaveAttribute('aria-expanded', 'false')
  await user.click(process)
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await user.click(disclosure)
  await user.click(tool)
  rerender(view(false))
  expect(process).toHaveAttribute('aria-expanded', 'false')
  expect(disclosure.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(tool.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.getByText('最终回复保持可见')).toBeVisible()
  await user.click(process)
  expect(disclosure).toBeVisible()
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  expect(tool).toHaveAttribute('aria-expanded', 'false')
  rerender(view(false))
  expect(process).toHaveAttribute('aria-expanded', 'true')
  rerender(view(true))
  expect(process).toHaveAttribute('aria-expanded', 'true')
  rerender(view(false))
  expect(process).toHaveAttribute('aria-expanded', 'false')
})

test('连续思考和工具只占一个活动组，分组和思考均可用键盘展开', async () => {
  const user = userEvent.setup()
  render(
    <ActivityGroup
      isLive
      items={[
        ...items,
        { id: 'more-thinking', type: 'thinking', thinking: '检查结果', status: 'success' },
        { id: 'bash', type: 'tool', name: 'bash', args: { command: 'pnpm test' }, result: '通过' },
      ]}
    />,
  )
  const group = screen.getByRole('button', { name: /^活动详情：/ })
  expect(group).toHaveAttribute('aria-expanded', 'false')
  group.focus()
  await user.keyboard('{Enter}')
  const tool = screen.getByRole('button', { name: '工具详情：write' })
  await user.click(tool)
  expect(tool).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('文件结果').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'false')
  const thinking = screen.getAllByRole('button', { name: '思考过程' })[0]!
  thinking.focus()
  await user.keyboard('{Enter}')
  expect(thinking).toHaveAttribute('aria-expanded', 'true')
  await user.keyboard(' ')
  expect(thinking).toHaveAttribute('aria-expanded', 'false')
  await user.keyboard('{Enter}')
  expect(thinking).toHaveAttribute('aria-expanded', 'true')
  group.focus()
  await user.keyboard(' ')
  expect(group).toHaveAttribute('aria-expanded', 'false')
  expect(tool.isConnected).toBe(true)
  expect(tool.closest('[aria-hidden="true"]')).not.toBeNull()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '工具详情：write' })).toBe(tool)
  expect(tool).toHaveAttribute('aria-expanded', 'false')
  expect(thinking).toHaveAttribute('aria-expanded', 'false')
})

test('流式正文进入工作过程后保留原节点，结束时收起中间正文并支持再次展开', async () => {
  const user = userEvent.setup()
  const input = userMessage('检查退出顺序', 1000)
  const progress = assistantMessage('我先检查退出顺序。', 1100)
  const call = assistantMessage([{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'main.ts' } }], 1200)
  const view = (
    messages: Parameters<typeof groupConversationTurns>[0],
    live: typeof progress | null,
    running: boolean,
  ) => {
    const turn = groupConversationTurns(messages, live, {}, running).find((chunk) => chunk.type === 'assistant_turn')!
    if (turn.type !== 'assistant_turn') throw new Error('测试数据缺少助手轮次')
    return (
      <TooltipProvider>
        <AssistantTurnView turn={turn} />
      </TooltipProvider>
    )
  }
  const { rerender } = render(view([input], progress, true))
  const paragraph = screen.getByText('我先检查退出顺序。')
  rerender(view([input, progress], call, true))
  expect(screen.getByText('我先检查退出顺序。')).toBe(paragraph)
  expect(paragraph).toBeVisible()
  rerender(view([input, progress, call, assistantMessage('退出顺序已确认。', 1300)], null, false))
  expect(screen.getByText('我先检查退出顺序。')).toBe(paragraph)
  expect(paragraph.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.getByText('退出顺序已确认。')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '工作过程' }))
  expect(screen.getByText('我先检查退出顺序。')).toBe(paragraph)
  expect(paragraph).toBeVisible()
})

test('历史轮次默认收起过程，计时总开关可用键盘展开且不收起最终回复或错误', async () => {
  const user = userEvent.setup()
  render(
    <TooltipProvider>
      <AssistantTurnView
        turn={{
          type: 'assistant_turn',
          key: 'history',
          activities: [{ id: 'note', type: 'narration', text: '先检查连接。' }, ...items],
          finalText: '已确认退出顺序。',
          images: [],
          errorMessage: '连接已中断',
          durationMs: 37000,
          isLive: false,
        }}
      />
    </TooltipProvider>,
  )
  const process = screen.getByRole('button', { name: '工作过程' })
  expect(process).toHaveTextContent('用时 37秒')
  expect(process).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('先检查连接。').closest('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^活动详情：/ })).toBeNull()
  expect(screen.getByText('已确认退出顺序。')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('连接已中断')
  expect(screen.getByRole('status')).toBeVisible()
  process.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByText('先检查连接。')).toBeVisible()
  expect(screen.getByRole('button', { name: /^活动详情：/ })).toBeVisible()
  await user.keyboard(' ')
  expect(screen.getByText('先检查连接。').closest('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.getByText('已确认退出顺序。')).toBeVisible()
})

test('子代理状态切开的中间回复不显示消息操作，整轮结束后仅最终回复可以复制和分叉', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const onFork = vi.fn()
  const chat: ChatState = {
    ...emptyChat,
    running: true,
    messages: [
      userMessage('启动子代理并汇总结果', 1000),
      assistantMessage('我先安排子代理。', 1100),
      assistantMessage('我会检查它们的执行结果。', 1400),
      assistantMessage('结果已返回，准备汇总。', 1700),
    ],
    agentMessages: [
      {
        id: 'result',
        fromAgentId: 'worker',
        toAgentId: 'root',
        runId: 'run',
        rootTaskId: 'task',
        epoch: 1,
        kind: 'result',
        name: '检查文件',
        status: 'completed',
        text: '子代理报告',
        startedAt: new Date(1200).toISOString(),
        completedAt: new Date(1500).toISOString(),
        createdAt: new Date(1500).toISOString(),
      },
    ],
  }
  const view = (state: ChatState) => (
    <TooltipProvider>
      <Conversation
        chat={state}
        canEditMessages={!state.running}
        onEditMessage={() => {}}
        onForkReply={onFork}
        onCopyError={() => {}}
      />
    </TooltipProvider>
  )
  const { container, rerender } = render(view(chat))
  const replies = () => [...container.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')]
  const expectNoActions = (reply: HTMLElement) => {
    expect(within(reply).queryByRole('button', { name: '复制消息' })).toBeNull()
    expect(within(reply).queryByRole('button', { name: '从这段回复新建会话' })).toBeNull()
  }
  expect(replies()).toHaveLength(3)
  replies().forEach(expectNoActions)
  const completed: ChatState = {
    ...chat,
    messages: [
      ...chat.messages,
      assistantMessage(
        [
          { type: 'thinking', thinking: '汇总子代理结果。' },
          { type: 'text', text: '最终结果已汇总。' },
        ],
        2000,
      ),
    ],
  }
  rerender(view(completed))
  replies().forEach(expectNoActions)
  rerender(view({ ...completed, running: false }))
  replies().slice(0, -1).forEach(expectNoActions)
  const final = within(replies().at(-1)!)
  await user.click(final.getByRole('button', { name: '复制消息' }))
  expect(writeText).toHaveBeenCalledExactlyOnceWith('最终结果已汇总。')
  await user.click(final.getByRole('button', { name: '从这段回复新建会话' }))
  expect(onFork).toHaveBeenCalledExactlyOnceWith(1700)
  rerender(
    view({
      ...completed,
      messages: [...completed.messages, userMessage('继续检查', 3000), assistantMessage('我继续检查。', 3100)],
    }),
  )
  expect(within(replies()[2]!).getByRole('button', { name: '从这段回复新建会话' })).toBeInTheDocument()
  expectNoActions(replies().at(-1)!)
})

test('活动摘要不提示调用失败，错误输出仅在手动展开工具后显示', async () => {
  const user = userEvent.setup()
  render(
    <ActivityGroup
      items={[
        ...items,
        {
          id: 'failed',
          name: 'bash',
          args: { command: 'pnpm type-check' },
          result: '关闭状态的类型不匹配',
          status: 'error',
        },
      ]}
    />,
  )
  const group = screen.getByRole('button', { name: /^活动详情：/ })
  expect(group).toHaveAttribute('aria-expanded', 'false')
  expect(group).not.toHaveAccessibleName(/失败/)
  expect(screen.queryByText('有调用失败')).toBeNull()
  await user.click(group)
  const tool = screen.getByRole('button', { name: '工具详情：bash' })
  expect(tool).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('关闭状态的类型不匹配').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true')
  expect(tool).toHaveTextContent('失败')
  await user.click(tool)
  expect(screen.getByText('关闭状态的类型不匹配')).toBeVisible()
  await user.click(group)
  await user.click(group)
  expect(tool).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('有调用失败')).toBeNull()
})

test('折叠工具或活动组时递归收起嵌套工具，再次展开保留节点但不恢复展开状态', async () => {
  const user = userEvent.setup()
  render(
    <ActivityGroup
      items={[
        {
          id: 'outer',
          name: 'codemode',
          status: 'success',
          children: [
            {
              id: 'middle',
              name: 'bash',
              status: 'success',
              children: [{ id: 'inner', name: 'write', status: 'success', result: '嵌套文件结果' }],
            },
          ],
        },
      ]}
    />,
  )
  const group = screen.getByRole('button', { name: /^活动详情：/ })
  await user.click(group)
  const outer = screen.getByRole('button', { name: '工具详情：codemode' })
  await user.click(outer)
  const middle = screen.getByRole('button', { name: '工具详情：bash' })
  await user.click(middle)
  const inner = screen.getByRole('button', { name: '工具详情：write' })
  await user.click(inner)
  expect(screen.getByText('嵌套文件结果')).toBeVisible()
  await user.click(outer)
  expect(middle).toHaveAttribute('aria-expanded', 'false')
  expect(inner).toHaveAttribute('aria-expanded', 'false')
  await user.click(outer)
  await user.click(middle)
  expect(screen.getByRole('button', { name: '工具详情：write' })).toBe(inner)
  expect(inner).toHaveAttribute('aria-expanded', 'false')
  await user.click(inner)
  await user.click(group)
  expect(outer).toHaveAttribute('aria-expanded', 'false')
  expect(middle).toHaveAttribute('aria-expanded', 'false')
  expect(inner).toHaveAttribute('aria-expanded', 'false')
  await user.click(group)
  await user.click(outer)
  expect(screen.getByRole('button', { name: '工具详情：bash' })).toBe(middle)
  expect(middle).toHaveAttribute('aria-expanded', 'false')
})

test('折叠的嵌套提问显示等待，完成后不再使用等待文案', () => {
  const pending: ActivityItem[] = [
    {
      id: 'parent',
      name: 'codemode',
      status: 'running',
      children: [{ id: 'question', name: 'request_user_input', status: 'running' }],
    },
  ]
  const { rerender } = render(<ActivityGroup items={pending} isLive />)
  expect(screen.getByRole('button', { name: /^活动详情：/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('status')).toHaveTextContent('等待你的回答')
  rerender(<ActivityGroup items={pending} />)
  expect(screen.queryByRole('button', { name: /等待你的回答/ })).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

test('父活动摘要在工具开始、输出更新和结束时保留文案、图标与展开节点', () => {
  const view = (status: 'running' | 'success', result?: string) => (
    <ActivityGroup isLive items={[...items, { id: 'code', name: 'codemode', status, result }]} />
  )
  const { rerender } = render(view('success', '已检查文件'))
  const group = screen.getByRole('button', { name: /^活动详情：/ })
  const icon = group.querySelector('svg')
  const label = group.textContent
  for (const [status, result] of [
    ['running', undefined],
    ['running', '正在检查文件'],
    ['success', '已检查文件'],
    ['running', undefined],
  ] as const) {
    rerender(view(status, result))
    expect(screen.getByRole('button', { name: /^活动详情：/ })).toBe(group)
    expect(group.querySelector('svg')).toBe(icon)
    expect(group.textContent).toBe(label)
  }
})

test('完整工具事件流持续保留父活动行，结果补录不重建已有活动', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const user = userEvent.setup()
  const stream = new ChatStream({
    ...emptyChat,
    running: true,
    messages: [
      userMessage('检查文件', 1000),
      assistantMessage(
        [
          { type: 'thinking', thinking: '检查项目' },
          { type: 'toolCall', id: 'late-result', name: 'read', arguments: { path: 'old.ts' } },
        ],
        2000,
      ),
    ],
    agentMessages: [
      {
        id: 'completed-worker',
        fromAgentId: 'worker',
        toAgentId: 'root',
        runId: 'run',
        rootTaskId: 'task',
        epoch: 1,
        kind: 'result',
        name: '检查文件',
        status: 'completed',
        text: '子代理报告',
        startedAt: new Date(1200).toISOString(),
        completedAt: new Date(1800).toISOString(),
        createdAt: new Date(1800).toISOString(),
      },
    ],
  })
  render(
    <TooltipProvider>
      <Conversation
        chat={stream.getSnapshot()}
        stream={stream}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>,
  )
  const group = screen.getByRole('button', { name: /^活动详情：/ })
  await user.click(group)
  const commit = (event: PiEvent) => {
    act(() => stream.update((state) => applyEvent(state, event)))
    expect(group.isConnected).toBe(true)
    expect(screen.getByRole('button', { name: /^活动详情：/ })).toBe(group)
    expect(group).toHaveAttribute('aria-expanded', 'true')
  }
  for (let index = 0; index < 3; index++) {
    const id = `call-${index}`
    const timestamp = 3000 + index * 1000
    const message = assistantMessage(
      [
        { type: 'thinking', thinking: '继续检查' },
        { type: 'toolCall', id, name: 'codemode', arguments: { code: '检查文件' } },
      ],
      timestamp,
    )
    commit({ type: 'message_start', message: assistantMessage([], timestamp) })
    commit(streamUpdate({ type: 'thinking_start', contentIndex: 0 }))
    commit(streamUpdate({ type: 'thinking_delta', contentIndex: 0, delta: '继续检查' }))
    commit(streamUpdate({ type: 'thinking_end', contentIndex: 0, content: '继续检查' }))
    commit(streamUpdate({ type: 'toolcall_start', contentIndex: 1, id, toolName: 'codemode' }))
    commit(streamUpdate({ type: 'toolcall_delta', contentIndex: 1, delta: '{"code":"检查文件"}' }))
    commit(
      streamUpdate({
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: message.content[1] as Extract<(typeof message.content)[number], { type: 'toolCall' }>,
      }),
    )
    commit({ type: 'message_end', message })
    commit({ type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: { code: '检查文件' } })
    commit({
      type: 'tool_execution_update',
      toolCallId: id,
      toolName: 'codemode',
      args: { code: '检查文件' },
      partialResult: '正在检查',
    })
    commit({ type: 'tool_execution_end', toolCallId: id, toolName: 'codemode', result: '检查完成', isError: false })
    commit({ type: 'message_end', message: toolResult(id, '检查完成', timestamp + 500) })
  }
  commit({ type: 'message_end', message: toolResult('late-result', '补录较早的工具结果', 1500) })
  commit({ type: 'message_end', message: assistantMessage('检查完成。', 7000) })
  act(() => stream.update((state) => applyEvent(state, { type: 'agent_settled' })))
  expect(group.isConnected).toBe(true)
  expect(group.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.getByRole('button', { name: '工作过程' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('检查完成。')).toBeVisible()
})
