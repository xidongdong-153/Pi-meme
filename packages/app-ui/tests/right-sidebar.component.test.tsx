import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { RightSidebar, type RightSidebarTab } from '../src/layout/right-sidebar'

afterEach(cleanup)

test('只显示有内容的标签，点击后更新选中状态和正文', async () => {
  const user = userEvent.setup()
  function Sidebar() {
    const [tab, select] = useState<RightSidebarTab>('plan')
    return (
      <RightSidebar availableTabs={['plan', 'session-tree']} tab={tab} onTab={select} onClose={() => {}} width={352}>
        {tab}
      </RightSidebar>
    )
  }
  render(<Sidebar />)
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['会话树', '计划'])
  expect(screen.getByRole('tab', { name: '计划' })).toHaveAttribute('aria-selected', 'true')
  await user.click(screen.getByRole('tab', { name: '会话树' }))
  expect(screen.getByRole('tab', { name: '会话树' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tabpanel')).toHaveTextContent('session-tree')
})

test('空内容仍可关闭，Escape 与关闭按钮分别通知调用者', async () => {
  const user = userEvent.setup()
  const close = vi.fn()
  render(
    <RightSidebar availableTabs={[]} tab={undefined} onTab={() => {}} onClose={close} width={352}>
      {null}
    </RightSidebar>,
  )
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  const button = screen.getByRole('button', { name: '关闭右侧栏' })
  await user.click(button)
  await user.keyboard('{Escape}')
  expect(close).toHaveBeenCalledTimes(2)
})

test.each([
  ['git', 'Git 变更'],
  ['subagents', '子代理'],
] as const)('单独显示 %s 时不附带其他标签', (tab, label) => {
  render(
    <RightSidebar availableTabs={[tab]} tab={tab} onTab={() => {}} onClose={() => {}} width={352}>
      {null}
    </RightSidebar>,
  )
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true')
})
