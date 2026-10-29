import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VisualizationRendererContext } from '@pi-meme/ui/components/visualization-renderer'
import { visualizationMarkdown } from '@pi-meme/contracts/visualize'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'
import { ChatMessage } from '../src/ui/conversation/chat-message'
import { ThinkingActivityRow } from '../src/ui/conversation/thinking-activity-row'
import { ToolActivityRow } from '../src/ui/conversation/tool-activity-row'
import { TurnChangesCard } from '../src/ui/conversation/turn-changes'
import { formatMessageTime, formatMessageTimeTitle } from '../src/ui/model/message-time'
import type { ActivityItem, ChatState } from '../src/ui/model/types'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { Conversation } from '../src/ui/conversation/conversation'
import { ChatStream } from '../src/ui/model/chat-stream'
import { applyEvent, emptyChat, fromSnapshot } from '../src/ui/model/state'
import type { PiEvent } from '@pi-meme/contracts/pi'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { projectAgentConversation } from '../src/ui/model/agent-collaboration'
import { parseToolMeta } from '../src/ui/model/tool-details'
import { runningActivityLabel, summarizeActivities } from '../src/ui/model/activity-summary'
import {
  assistantMessage,
  sessionState,
  streamUpdate,
  toolResult,
  userMessage,
} from '../../../tests/fixtures/messages.mjs'

afterEach(cleanup)

test.each([
  { name: 'bash', args: { command: 'printf "第一行\\n第二行"' }, label: '复制命令', code: 'printf "第一行\\n第二行"' },
  { name: 'exec_command', args: { cmd: 'pnpm type-check' }, label: '复制命令', code: 'pnpm type-check' },
  { name: 'terminal', args: { CommandLine: 'git status' }, label: '复制命令', code: 'git status' },
  {
    name: 'codemode',
    args: { code: 'console.log(1)\nconsole.log(2)' },
    label: '复制脚本',
    code: 'console.log(1)\nconsole.log(2)',
  },
])('$name 的脚本和输出分别复制完整原文', async ({ name, args, label, code }) => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const output = Array.from({ length: 80 }, (_, index) => `输出 ${index + 1}`).join('\n')
  render(
    <ToolActivityRow
      item={{ id: 'execution', name, args, result: { content: [{ type: 'text', text: output }] }, status: 'success' }}
      open
      onToggle={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: label }))
  expect(writeText).toHaveBeenLastCalledWith(code)
  await user.click(screen.getByRole('button', { name: '复制输出' }))
  expect(writeText).toHaveBeenLastCalledWith(output)
})

test.each(['ls', 'grep'])('$name 的通用详情可以复制完整输出', async (name) => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const output = '.codex/\n.editorconfig\npackages/\npackage.json'
  render(<ToolActivityRow item={{ id: 'generic', name, result: output, status: 'success' }} open onToggle={() => {}} />)
  expect(screen.getByRole('region', { name: '执行输出' }).textContent).toBe(output)
  await user.click(screen.getByRole('button', { name: '复制输出' }))
  expect(writeText).toHaveBeenLastCalledWith(output)
  expect(screen.queryByRole('button', { name: '复制命令' })).toBeNull()
})

test('命令等待输出时不把参数当输出，流式更新后复制最新内容，空输出仍保留命令', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const item = { id: 'execution', name: 'bash', command: 'pnpm lint', args: { command: '旧命令' } }
  const { rerender } = render(<ToolActivityRow item={{ ...item, status: 'running' }} open onToggle={() => {}} />)
  expect(screen.getByRole('region', { name: '执行输出' })).toHaveTextContent('等待输出…')
  expect(screen.queryByRole('button', { name: '复制输出' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '复制命令' }))
  expect(writeText).toHaveBeenLastCalledWith('pnpm lint')
  rerender(<ToolActivityRow item={{ ...item, status: 'running', output: '第一行\n第二行' }} open onToggle={() => {}} />)
  await user.click(screen.getByRole('button', { name: '复制输出' }))
  expect(writeText).toHaveBeenLastCalledWith('第一行\n第二行')
  rerender(<ToolActivityRow item={{ ...item, status: 'success', output: '' }} open onToggle={() => {}} />)
  expect(screen.getByRole('region', { name: '执行输出' })).toHaveTextContent('无输出')
  expect(screen.getByRole('region', { name: '执行命令' })).toHaveTextContent('pnpm lint')
})

test.each(['edit', 'write'])('正式消息和历史恢复后 $name 仍显示统计并可展开 Diff', async (name) => {
  const user = userEvent.setup()
  const patch = '@@ -0,0 +1,1 @@\n+const value = 1\n'
  const assistant = assistantMessage([{ type: 'toolCall', id: 'file-change', name, arguments: { path: 'example.ts' } }])
  const message = {
    ...toolResult('file-change', '文件已保存', 2),
    toolName: name,
    details: { patch, created: name === 'write' },
  }
  let state = applyEvent(emptyChat, { type: 'message_end', message: assistant })
  state = applyEvent(state, {
    type: 'tool_execution_end',
    toolCallId: 'file-change',
    toolName: name,
    result: { content: message.content, details: message.details },
    isError: false,
  })
  state = applyEvent(state, { type: 'message_end', message })
  const restored = fromSnapshot({
    connection: { generation: 1, cwd: '/tmp', status: 'ready' },
    state: { ...sessionState(), mode: 'default' },
    messages: state.messages,
    models: [],
  })
  for (const current of [state, restored]) {
    const turns = groupConversationTurns(current.messages, null, current.tools, false)
    const turn = turns.find((entry) => entry.type === 'assistant_turn')
    if (turn?.type !== 'assistant_turn') throw new Error('缺少工具活动')
    const item = turn.activities[0]
    if (item.type !== 'tool') throw new Error('预期文件工具活动')
    const onToggle = vi.fn()
    const view = render(<ToolActivityRow item={item} open={false} onToggle={onToggle} />)
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−0')).toBeInTheDocument()
    if (name === 'write') expect(screen.getByLabelText('新建文件')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `工具详情：${name}` }))
    expect(onToggle).toHaveBeenCalledOnce()
    view.rerender(<ToolActivityRow item={item} open onToggle={onToggle} />)
    expect(screen.getByRole('region', { name: 'Diff 代码' })).toHaveTextContent('const value = 1')
    view.unmount()
  }
})

test('本轮卡片携带消息与文件目标打开详情，撤销失败保留错误且可重试', async () => {
  const user = userEvent.setup()
  const view = vi.fn()
  const undo = vi.fn().mockRejectedValueOnce(new Error('文件已有后续修改')).mockResolvedValue(undefined)
  render(
    <TurnChangesCard
      changes={{
        entryId: 'native-user',
        undone: false,
        insertions: 1,
        deletions: 0,
        files: [{ path: 'src/app.ts', insertions: 1, deletions: 0, patch: '+line' }],
      }}
      onView={view}
      onUndo={undo}
    />,
  )
  await user.click(screen.getByRole('button', { name: /src\/app.ts/ }))
  expect(view).toHaveBeenLastCalledWith('native-user', 'src/app.ts')
  await user.click(screen.getByRole('button', { name: '查看变更' }))
  expect(view).toHaveBeenLastCalledWith('native-user')
  await user.click(screen.getByRole('button', { name: '撤销' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('文件已有后续修改')
  await user.click(screen.getByRole('button', { name: '撤销' }))
  expect(undo).toHaveBeenCalledTimes(2)
  expect(undo).toHaveBeenLastCalledWith('native-user')
})

test('文件活动显示行数与创建标记，覆盖写入显示编辑', () => {
  const view = render(
    <ToolActivityRow
      item={{
        id: 'new',
        name: 'write',
        status: 'success',
        args: { path: 'new.ts' },
        result: { details: { created: true, patch: '@@ -0,0 +1 @@\n+new\n' } },
      }}
      open={false}
      onToggle={() => {}}
    />,
  )
  expect(screen.getByText('+1')).toBeInTheDocument()
  expect(screen.getByText('−0')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: '新建文件' })).toBeInTheDocument()
  view.unmount()
  const toggle = vi.fn()
  render(
    <ToolActivityRow
      item={{
        id: 'write',
        name: 'write',
        status: 'success',
        args: { path: 'existing.ts' },
        result: { details: { created: false, patch: '@@ -1 +1 @@\n-old\n+new\n' } },
      }}
      open={false}
      onToggle={toggle}
    />,
  )
  expect(screen.getByText('已编辑 existing.ts')).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: '新建文件' })).not.toBeInTheDocument()
  expect(screen.getByText('−1')).toBeInTheDocument()
  expect(toggle).not.toHaveBeenCalled()
})

test('图片生成与编辑不记为查看图像，失败操作不计入成功产物', () => {
  const generated: ActivityItem = {
    id: 'generate',
    name: 'image_gen',
    args: { prompt: '生成' },
    status: 'success',
    result: { details: { artifact: { path: '/host/generated.png' } } },
  }
  const edited: ActivityItem = {
    id: 'edit',
    name: 'image_gen',
    args: { prompt: '编辑', num_last_images_to_include: 1 },
    status: 'success',
  }
  const failed = { ...generated, id: 'failed', status: 'error' as const }
  expect(parseToolMeta(generated)).toMatchObject({
    kind: 'image-generation',
    summary: '已生成图片',
    fullPath: '/host/generated.png',
  })
  expect(parseToolMeta(edited).summary).toBe('已编辑图片')
  expect(summarizeActivities([generated, edited, failed]).summary).toBe(
    '生成了 1 张图片 · 编辑了 1 张图片 · 图片处理失败 1 次',
  )
  expect(runningActivityLabel([{ ...generated, status: 'running' }])).toBe('正在生成图片…')
  expect(runningActivityLabel([{ ...edited, status: 'running' }])).toBe('正在编辑图片…')
})

const items: ActivityItem[] = [
  { id: 'thinking', type: 'thinking', thinking: '检查文件', status: 'success' },
  {
    id: 'search',
    type: 'tool',
    name: 'grep',
    args: { pattern: 'TODO', path: 'a.ts' },
    result: '文件结果',
    status: 'success',
  },
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
          hideAgentOperations: true,
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
  expect(screen.queryByRole('button', { name: '工具详情：send_message' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '工具详情：wait_agent' })).not.toBeInTheDocument()
  expect(screen.queryByText(/已执行 send_message|已执行 wait_agent/)).not.toBeInTheDocument()
  const siblings = [...rows[0].parentElement!.children]
  expect(siblings.indexOf(disclosures[0].closest('[id]')!)).toBeLessThan(siblings.indexOf(rows[0]))
  expect(siblings.indexOf(rows[0])).toBeLessThan(siblings.indexOf(disclosures[1].closest('[id]')!))
  await user.click(disclosures[0])
  expect(screen.queryByRole('button', { name: '工具详情：send_message' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '工具详情：grep' })).toBeInTheDocument()
  await user.click(disclosures[1])
  expect(screen.queryByRole('button', { name: '工具详情：wait_agent' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '工具详情：bash' })).toBeInTheDocument()
  await user.click(disclosures[0])
  await user.click(disclosures[1])
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
  expect(screen.queryByRole('button', { name: '工作过程' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '工具详情：wait_agent' })).not.toBeInTheDocument()
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
  expect(screen.queryByRole('button', { name: '工具详情：send_message' })).not.toBeInTheDocument()
  expect(screen.queryByText(/已执行 send_message|正在执行 send_message/)).not.toBeInTheDocument()
  expect(screen.queryByText('内部协作正文')).not.toBeInTheDocument()
})

test('用户消息和助手回复都显示真实时间', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const stamp = new Date(2020, 5, 15, 9, 43).getTime()
  render(
    <TooltipProvider>
      <ChatMessage message={userMessage('你好', stamp)} tools={{}} />
      <AssistantTurnView
        turn={{
          type: 'assistant_turn',
          key: 'reply',
          activities: [],
          finalText: '回复',
          images: [],
          repliedAt: stamp,
          isLive: false,
        }}
      />
    </TooltipProvider>,
  )
  const times = screen.getAllByLabelText(formatMessageTimeTitle(stamp))
  expect(times).toHaveLength(2)
  for (const time of times) {
    expect(time).toHaveTextContent(formatMessageTime(stamp))
    expect(time).toHaveAttribute('dateTime', new Date(stamp).toISOString())
  }
})

test('思考行与相邻工具行使用同一字号', () => {
  const { container } = render(
    <ThinkingActivityRow
      item={{ id: 'thinking', type: 'thinking', thinking: '对齐字号', status: 'success' }}
      open
      onToggle={() => {}}
    />,
  )
  const row = container.firstElementChild
  expect(row).toHaveClass('text-xs')
  expect(row).not.toHaveClass('text-sm')
  expect(container.querySelector('pre')).toHaveClass('text-xs')
  expect(container.querySelector('pre')).not.toHaveClass('text-sm')
})

test.each(
  (['read', 'edit', 'apply_patch', 'replace', 'write', 'create'] as const).flatMap((name) =>
    (['success', 'running', 'error'] as const)
      .filter((status) => name === 'read' || status !== 'success')
      .map((status) => ({ name, status })),
  ),
)('读取或未成功的文件操作不展开差异：$name / $status', async ({ name, status }) => {
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

test.each(['edit', 'write'])('成功的 $name 可展开带行号的 Diff、复制并通过键盘收起', async (name) => {
  const user = userEvent.setup()
  const patch =
    name === 'write'
      ? '@@ -0,0 +1,2 @@\n+const first = 1\n+const second = 2\n'
      : '@@ -1693,2 +1693,2 @@\n const first = 1\n-const oldValue = 2\n+const newValue = 3\n'
  const item = {
    id: name,
    name,
    status: 'success' as const,
    args: { path: 'src/example.ts' },
    result: { details: { patch, diff: '显示摘要', created: name === 'write' } },
  }
  const onToggle = vi.fn()
  const view = render(<ToolActivityRow item={item} open={false} onToggle={onToggle} />)
  const trigger = screen.getByRole('button', { name: `工具详情：${name}` })
  expect(screen.queryByRole('region', { name: 'Diff 代码' })).not.toBeInTheDocument()
  await user.click(trigger)
  expect(onToggle).toHaveBeenCalledOnce()
  view.rerender(<ToolActivityRow item={item} open onToggle={onToggle} />)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const diff = screen.getByRole('region', { name: 'Diff 代码' })
  expect(diff).toHaveTextContent('const first = 1')
  expect(diff).toHaveTextContent(name === 'write' ? 'const second = 2' : 'const newValue = 3')
  expect(diff).toHaveTextContent(name === 'write' ? '1' : '1693')
  expect(diff).not.toHaveTextContent('显示摘要')
  await user.click(screen.getByRole('button', { name: '复制 Diff' }))
  expect(await navigator.clipboard.readText()).toBe(patch)
  trigger.focus()
  await user.keyboard('{Enter}')
  expect(onToggle).toHaveBeenCalledTimes(2)
  view.rerender(<ToolActivityRow item={item} open={false} onToggle={onToggle} />)
  expect(screen.queryByRole('region', { name: 'Diff 代码' })).not.toBeInTheDocument()
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
  expect(screen.getByRole('button', { name: '工具详情：read' })).toHaveTextContent('失败')
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
  const tool = screen.getByRole('button', { name: '工具详情：grep' })
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
  const tool = screen.getByRole('button', { name: '工具详情：grep' })
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
  expect(screen.getByRole('button', { name: '工具详情：grep' })).toBe(tool)
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
  expect(onFork).toHaveBeenCalledExactlyOnceWith(1000)
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
              children: [{ id: 'inner', name: 'grep', status: 'success', result: '嵌套文件结果' }],
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
  const inner = screen.getByRole('button', { name: '工具详情：grep' })
  await user.click(inner)
  expect(screen.getByText('嵌套文件结果')).toBeVisible()
  await user.click(outer)
  expect(middle).toHaveAttribute('aria-expanded', 'false')
  expect(inner).toHaveAttribute('aria-expanded', 'false')
  await user.click(outer)
  await user.click(middle)
  expect(screen.getByRole('button', { name: '工具详情：grep' })).toBe(inner)
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

test('草图在工具成功后直接可见，轮次结束和收起工作过程后保持同一预览', async () => {
  const user = userEvent.setup()
  const reference = { id: '12345678-1234-1234-1234-123456789012', revision: 1 }
  const preview = (ref: typeof reference) => <button>草图预览 {ref.revision}</button>
  const view = (status: 'running' | 'success', isLive: boolean, finalText = '') => (
    <TooltipProvider>
      <VisualizationRendererContext.Provider value={preview}>
        <AssistantTurnView
          turn={{
            type: 'assistant_turn',
            key: 'visualize-turn',
            isLive,
            finalText,
            images: [],
            activities: [
              {
                id: 'save',
                type: 'tool',
                name: 'save_visualization',
                status,
                result: status === 'success' ? { details: { visualization: reference } } : undefined,
              },
            ],
          }}
        />
      </VisualizationRendererContext.Provider>
    </TooltipProvider>
  )
  const { rerender } = render(view('running', true))
  expect(screen.queryByRole('button', { name: '草图预览 1' })).toBeNull()
  rerender(view('success', true))
  const card = screen.getByRole('button', { name: '草图预览 1' })
  expect(card.closest('[aria-hidden="true"], [inert]')).toBeNull()
  await user.click(screen.getByRole('button', { name: '工作过程' }))
  expect(screen.getByRole('button', { name: '草图预览 1' })).toBe(card)
  rerender(view('success', false, '草图已生成，可以直接操作。'))
  expect(screen.getByRole('button', { name: '草图预览 1' })).toBe(card)
  expect(card.closest('[aria-hidden="true"], [inert]')).toBeNull()
  await user.click(screen.getByRole('button', { name: '工作过程' }))
  expect(screen.getAllByText('草图预览 1')).toHaveLength(1)
})

test('历史轮次直接显示全部成功草图版本，正文引用不重复，失败结果不展示', () => {
  const reference = { id: '12345678-1234-1234-1234-123456789012', revision: 1 }
  const saved = (revision: number): Extract<ActivityItem, { type?: 'tool' }> => ({
    id: `save-${revision}`,
    type: 'tool',
    name: 'save_visualization',
    status: 'success',
    result: { details: { visualization: { ...reference, revision } } },
  })
  render(
    <TooltipProvider>
      <VisualizationRendererContext.Provider value={(ref) => <button>草图预览 {ref.revision}</button>}>
        <AssistantTurnView
          turn={{
            type: 'assistant_turn',
            key: 'history-visualize',
            isLive: false,
            images: [],
            finalText: `已更新。\n${visualizationMarkdown({ ...reference, revision: 2 })}`,
            activities: [
              saved(1),
              saved(2),
              { ...saved(2), id: 'retry' },
              { ...saved(3), status: 'error' },
              { ...saved(4), result: { details: { visualization: { id: 'bad', revision: 4 } } } },
            ],
          }}
        />
      </VisualizationRendererContext.Provider>
    </TooltipProvider>,
  )
  expect(screen.getByRole('button', { name: '草图预览 1' })).toBeVisible()
  expect(screen.getAllByText('草图预览 2')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '草图预览 2' })).toBeVisible()
  expect(screen.queryByText('草图预览 3')).toBeNull()
  expect(screen.queryByText('草图引用无效。')).toBeNull()
})
