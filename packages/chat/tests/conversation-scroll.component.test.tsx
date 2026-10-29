import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Conversation } from '../src/ui/conversation/conversation'
import { emptyChat } from '../src/ui/model/state'
import type { ChatState } from '../src/ui/model/types'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

function createChatState(messages: ChatState['messages'] = []): ChatState {
  return {
    ...emptyChat,
    messages,
  }
}

test('刚开始对话且内容未铺开（不可滚动）时，不显示回到底部箭头', async () => {
  const chat = createChatState([userMessage('测试第一句话', 1000), assistantMessage('收到，正在处理...', 2000)])

  const { container } = render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>,
  )

  const scrollContainer = container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  expect(scrollContainer).toBeInTheDocument()

  // 模拟内容未撑满（不可滚动）：clientHeight = 800, scrollHeight = 400
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 800, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollHeight', { value: 400, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true })

  act(() => {
    fireEvent.scroll(scrollContainer)
  })

  expect(screen.queryByRole('button', { name: '滚动到底部' })).not.toBeInTheDocument()
})

test('内容铺开且向上滚动离开底部时显示箭头，点击后调用平滑吸底并隐藏', async () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')

  const chat = createChatState([userMessage('用户输入', 1000), assistantMessage('较长的输出内容...', 2000)])

  const { container } = render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>,
  )

  const scrollContainer = container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  expect(scrollContainer).toBeInTheDocument()

  // 模拟长内容已铺开：clientHeight = 500, scrollHeight = 1500
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1500, configurable: true })
  // 向上滚动：scrollTop = 400，离底部还有 1500 - 400 - 500 = 600px > 80px
  Object.defineProperty(scrollContainer, 'scrollTop', { value: 400, writable: true, configurable: true })

  act(() => {
    fireEvent.scroll(scrollContainer)
  })

  // 应该显示回到底部箭头
  const button = screen.getByRole('button', { name: '滚动到底部' })
  expect(button).toBeInTheDocument()

  const scrollTo = vi.fn()
  scrollContainer.scrollTo = scrollTo
  scrollIntoView.mockClear()

  // 点击回到底部
  act(() => {
    fireEvent.click(button)
  })

  expect(scrollTo).toHaveBeenCalledWith({ top: 1500, behavior: 'smooth' })
  expect(scrollIntoView).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '滚动到底部' })).not.toBeInTheDocument()
})

test('打开会话和更新消息只滚动消息容器，不连带滚动外层页面', () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  const view = (chat: ChatState) => (
    <TooltipProvider>
      <Conversation
        chat={chat}
        sessionKey="scroll-isolation"
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>
  )
  const chat = createChatState([userMessage('用户输入', 1000), assistantMessage('回复', 2000)])
  const { container, rerender } = render(view(chat))
  expect(scrollIntoView).not.toHaveBeenCalled()

  const scrollContainer = container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1500, configurable: true })
  scrollContainer.scrollTop = 1000
  fireEvent.scroll(scrollContainer)

  Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1800, configurable: true })
  rerender(view(createChatState([...chat.messages, assistantMessage('新增回复', 3000)])))
  expect(scrollContainer.scrollTop).toBe(1800)
  expect(scrollIntoView).not.toHaveBeenCalled()
})

test('内容铺开但在底部附近时，不显示回到底部箭头', async () => {
  const chat = createChatState([userMessage('用户输入', 1000), assistantMessage('回复', 2000)])

  const { container } = render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>,
  )

  const scrollContainer = container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  expect(scrollContainer).toBeInTheDocument()

  // 模拟长内容已铺开：clientHeight = 500, scrollHeight = 1500
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1500, configurable: true })
  // 处于底部：scrollTop = 960，距离底部 1500 - 960 - 500 = 40px <= 80px
  Object.defineProperty(scrollContainer, 'scrollTop', { value: 960, writable: true, configurable: true })

  act(() => {
    fireEvent.scroll(scrollContainer)
  })

  expect(screen.queryByRole('button', { name: '滚动到底部' })).not.toBeInTheDocument()
})

test('工作过程折叠/展开不会误将吸底状态破坏导致弹出箭头', async () => {
  const chat = createChatState([
    userMessage('用户输入', 1000),
    assistantMessage(
      [
        { type: 'thinking', thinking: '思考细节' },
        { type: 'text', text: '完成回答' },
      ],
      2000,
    ),
  ])

  const { container } = render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
      />
    </TooltipProvider>,
  )

  const scrollContainer = container.querySelector('[aria-label="对话消息流"]') as HTMLDivElement
  expect(scrollContainer).toBeInTheDocument()

  // 即使在较小内容未铺开或刚铺开时点击工作过程切换
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollHeight', { value: 650, configurable: true })
  Object.defineProperty(scrollContainer, 'scrollTop', { value: 50, writable: true, configurable: true })

  const toggle = screen.queryByRole('button', { name: '工作过程' })
  if (toggle) {
    act(() => {
      fireEvent.click(toggle)
    })
  }

  expect(screen.queryByRole('button', { name: '滚动到底部' })).not.toBeInTheDocument()
})

test('保存计划在所属轮次渲染卡片，替换完整最终正文', () => {
  const document = {
    id: 'plan',
    sessionId: 'session',
    runId: 'run',
    revision: 1,
    title: '计划',
    markdown: '# 计划正文',
    updatedAt: '2026-10-26T00:00:00Z',
  }
  const chat = createChatState([
    userMessage('设计方案', 1000),
    {
      ...assistantMessage('', 2000),
      content: [
        { type: 'toolCall', id: 'save', name: 'save_plan', arguments: { title: '计划', markdown: '# 计划正文' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'save',
      toolName: 'save_plan',
      content: [{ type: 'text', text: '已保存' }],
      details: document,
      isError: false,
      timestamp: 2100,
    },
    assistantMessage('不应再次展开的完整计划正文', 2200),
  ])
  chat.planDocuments = [document]
  chat.running = true
  const view = (state: ChatState) => (
    <TooltipProvider>
      <Conversation
        chat={state}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
        renderPlan={(value) => <section aria-label="计划卡片">{value.title}</section>}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view(chat))
  expect(screen.queryByRole('region', { name: '计划卡片' })).not.toBeInTheDocument()
  rerender(view({ ...chat, running: false }))
  expect(screen.getAllByRole('region', { name: '计划卡片' })).toHaveLength(1)
  expect(screen.queryByText('不应再次展开的完整计划正文')).not.toBeInTheDocument()
})

test('调整后仅最新回复展示方案卡片，旧回复不重新展开计划正文', () => {
  const first = {
    id: 'plan',
    sessionId: 'session',
    runId: 'first',
    revision: 1,
    title: '旧方案',
    markdown: '# 旧方案',
    updatedAt: '2026-10-26T00:00:00Z',
  }
  const latest = { ...first, runId: 'second', revision: 2, title: '当前方案', markdown: '# 当前方案' }
  const messages = [first, latest].flatMap((document, index) => [
    userMessage(index ? '调整' : '设计', index * 1000 + 100),
    {
      ...assistantMessage('', index * 1000 + 200),
      content: [{ type: 'toolCall' as const, id: `save-${index}`, name: 'save_plan', arguments: {} }],
    },
    {
      role: 'toolResult' as const,
      toolName: 'save_plan',
      toolCallId: `save-${index}`,
      sourceEntry: { id: `saved-${index}`, type: 'message' as const, revision: `saved-${index}` },
      content: [{ type: 'text' as const, text: '已保存' }],
      details: document,
      isError: false,
      timestamp: index * 1000 + 300,
    },
    assistantMessage(`不应展开的方案正文${index}`, index * 1000 + 400),
  ])
  const chat = createChatState(messages)
  chat.planState = { sessionId: 'session', revision: 2, document: latest, sourceEntryId: 'saved-1' }
  chat.planDocuments = [latest]
  render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
        renderPlan={(document) => <section aria-label="计划卡片">{document.title}</section>}
      />
    </TooltipProvider>,
  )
  expect(screen.getAllByRole('region', { name: '计划卡片' })).toHaveLength(1)
  expect(screen.getByRole('region', { name: '计划卡片' })).toHaveTextContent('当前方案')
  expect(screen.queryByText('不应展开的方案正文0')).not.toBeInTheDocument()
  expect(screen.queryByText('不应展开的方案正文1')).not.toBeInTheDocument()
})

test.each(['分页', '上下文压缩'])('计划来源因%s不在当前消息中时，不在实施回复后补显', (reason) => {
  const document = {
    id: 'plan',
    sessionId: 'session',
    runId: 'planning',
    revision: 1,
    title: '实施方案',
    markdown: '# 实施方案',
    updatedAt: '2026-10-26T00:00:00Z',
  }
  const plannedMessages: ChatState['messages'] = [
    userMessage('设计方案', 1000),
    {
      ...assistantMessage('', 1100),
      content: [{ type: 'toolCall', id: 'save', name: 'save_plan', arguments: {} }],
    },
    {
      role: 'toolResult',
      toolName: 'save_plan',
      toolCallId: 'save',
      sourceEntry: { id: 'saved', type: 'message', revision: 'saved' },
      content: [{ type: 'text', text: '已保存' }],
      details: document,
      isError: false,
      timestamp: 1200,
    },
    assistantMessage('计划已保存', 1300),
  ]
  const implementationMessages = [userMessage('实施方案', 2000), assistantMessage('实施完成', 2100)]
  const chat = createChatState(implementationMessages)
  chat.planState = { sessionId: 'session', revision: 1, document, sourceEntryId: 'saved' }
  chat.messagePage = reason === '分页' ? { before: 'implementation' } : undefined
  const view = (state: ChatState) => (
    <TooltipProvider>
      <Conversation
        chat={state}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
        renderPlan={(value) => <section aria-label="计划卡片">{value.title}</section>}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view(chat))
  expect(screen.queryByRole('region', { name: '计划卡片' })).not.toBeInTheDocument()
  expect(screen.getByText('实施完成')).toBeInTheDocument()

  rerender(view({ ...chat, messages: [...plannedMessages, ...implementationMessages], messagePage: undefined }))
  const card = screen.getByRole('region', { name: '计划卡片' })
  expect(screen.getAllByRole('region', { name: '计划卡片' })).toHaveLength(1)
  expect(screen.getByText('实施完成').closest('article')).not.toContainElement(card)
  expect(card.closest('article')).toBeInTheDocument()
})

test('保存计划的原工具调用缺失时，残留工具活动不将卡片放到实施回复', () => {
  const document = {
    id: 'plan',
    sessionId: 'session',
    runId: 'planning',
    revision: 1,
    title: '实施方案',
    markdown: '# 实施方案',
    updatedAt: '2026-10-26T00:00:00Z',
  }
  const chat = createChatState([
    {
      role: 'toolResult',
      toolName: 'save_plan',
      toolCallId: 'save',
      sourceEntry: { id: 'saved', type: 'message', revision: 'saved' },
      content: [{ type: 'text', text: '已保存' }],
      details: document,
      isError: false,
      timestamp: 1200,
    },
    userMessage('实施方案', 2000),
    assistantMessage('实施完成', 2100),
  ])
  chat.planState = { sessionId: 'session', revision: 1, document, sourceEntryId: 'saved' }
  chat.tools = { save: { id: 'save', name: 'save_plan', status: 'success' } }
  render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
        renderPlan={(value) => <section aria-label="计划卡片">{value.title}</section>}
      />
    </TooltipProvider>,
  )
  expect(screen.queryByRole('region', { name: '计划卡片' })).not.toBeInTheDocument()
  expect(screen.getByText('实施完成')).toBeInTheDocument()
})

test('清空计划状态后不补显残留工具结果或孤立索引文档', () => {
  const chat = createChatState([userMessage('重新设计', 1000)])
  chat.planState = { sessionId: 'session', revision: 3 }
  chat.planDocuments = []
  render(
    <TooltipProvider>
      <Conversation
        chat={chat}
        canEditMessages={false}
        onEditMessage={() => {}}
        onForkReply={() => {}}
        onCopyError={() => {}}
        renderPlan={() => <section aria-label="计划卡片" />}
      />
    </TooltipProvider>,
  )
  expect(screen.queryByRole('region', { name: '计划卡片' })).not.toBeInTheDocument()
})
