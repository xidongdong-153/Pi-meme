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
  const scrollIntoView = vi.fn()
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView

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

  // 点击回到底部
  act(() => {
    fireEvent.click(button)
  })

  expect(scrollIntoView).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '滚动到底部' })).not.toBeInTheDocument()
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
  expect(screen.getAllByRole('region', { name: '计划卡片' })).toHaveLength(1)
  expect(screen.queryByText('不应再次展开的完整计划正文')).not.toBeInTheDocument()
})
