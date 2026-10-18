import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'
import type { ActivityItem } from '../src/ui/model/types'

afterEach(cleanup)

const items: ActivityItem[] = [
  { id: 'thinking', type: 'thinking', thinking: '检查文件', status: 'success' },
  { id: 'read', type: 'tool', name: 'read', args: { path: 'a.ts' }, result: '文件结果', status: 'success' },
]

test('运行时展开，流式更新保留手动选择，完成后收起并始终保留最终回复', async () => {
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
  const disclosure = screen.getByRole('button', { name: '工作过程' })
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')

  await user.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  rerender(view(true, [...items, { id: 'note', type: 'narration', text: '继续检查' }]))
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')

  await user.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  rerender(view(false))
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('最终回复保持可见').closest('[aria-hidden]')).toBeNull()

  await user.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  rerender(view(true))
  await user.click(disclosure)
  rerender(view(false))
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
})

test('工具分组和单项可分别展开，思考支持键盘切换', async () => {
  const user = userEvent.setup()
  render(
    <ActivityGroup
      isLive
      items={[...items, { id: 'bash', type: 'tool', name: 'bash', args: { command: 'pnpm test' }, result: '通过' }]}
    />,
  )
  const group = screen.getByRole('button', { name: '工具调用组' })
  expect(group).toHaveAttribute('aria-expanded', 'false')
  await user.click(group)
  const tool = screen.getByRole('button', { name: '工具详情：read' })
  await user.click(tool)
  expect(tool).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('文件结果').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'false')
  await user.click(group)
  expect(group).toHaveAttribute('aria-expanded', 'false')

  const thinking = screen.getByRole('button', { name: '思考过程' })
  thinking.focus()
  await user.keyboard('{Enter}')
  expect(thinking).toHaveAttribute('aria-expanded', 'true')
  await user.keyboard(' ')
  expect(thinking).toHaveAttribute('aria-expanded', 'false')
})
