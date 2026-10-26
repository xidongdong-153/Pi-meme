import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { PlanPanel } from '../src/panels/plan-panel'

afterEach(cleanup)

const older: PlanDocument = {
  id: 'older',
  sessionId: 'session',
  runId: 'run',
  revision: 1,
  title: '旧计划',
  markdown: '# 旧文档正文\n\n- 旧步骤',
  updatedAt: '2026-10-09T00:00:00Z',
}
const latest: PlanDocument = {
  ...older,
  id: 'latest',
  revision: 2,
  title: '新计划',
  markdown: '# 完整计划正文\n\n- 第一步\n- 第二步\n\n最后一段',
  updatedAt: '2026-10-10T00:00:00Z',
}

test('默认显示最新的完整只读 Markdown，提供复制与导出', () => {
  render(<PlanPanel documents={[older, latest]} />)
  const document = screen.getByRole('region', { name: '已保存计划：新计划' })
  expect(within(document).getByRole('heading', { name: '完整计划正文' })).toBeVisible()
  expect(
    within(document)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['第一步', '第二步'])
  expect(document).toHaveTextContent('最后一段')
  expect(within(document).getByRole('button', { name: '复制' })).toBeEnabled()
  expect(within(document).getByRole('button', { name: '导出 Markdown' })).toBeEnabled()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByText('旧文档正文')).not.toBeInTheDocument()
})

test('只展示当前方案，不提供方案选择器或版本文案', () => {
  render(<PlanPanel documents={[latest]} />)
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '已保存计划：新计划' })).not.toHaveTextContent('第 2 版')
})

test('会话切换后失效的选择回到新会话最新文档', () => {
  const { rerender } = render(<PlanPanel documents={[older, latest]} />)
  const next = { ...latest, id: 'next-session', sessionId: 'next', title: '另一个会话' }
  rerender(<PlanPanel documents={[next]} />)
  expect(screen.getByRole('region', { name: '已保存计划：另一个会话' })).toBeVisible()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
})

test('侧栏只负责阅读与文档操作，不提供另一条实施入口', () => {
  render(<PlanPanel documents={[latest]} />)
  expect(screen.queryByRole('button', { name: /实施|继续/ })).not.toBeInTheDocument()
})

test('复制完整正文后反馈成功', async () => {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  render(<PlanPanel documents={[latest]} />)
  await user.click(screen.getByRole('button', { name: '复制' }))
  expect(write).toHaveBeenCalledExactlyOnceWith(latest.markdown)
  expect(await screen.findByRole('button', { name: '已复制' })).toBeVisible()
})

test('复制失败显示具体原因，保留计划正文', async () => {
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('权限被拒绝'))
  render(<PlanPanel documents={[latest]} />)
  await user.click(screen.getByRole('button', { name: '复制' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('权限被拒绝')
  expect(screen.getByRole('heading', { name: '完整计划正文' })).toBeVisible()
})

test('空会话不保留其他会话文档或操作', () => {
  render(<PlanPanel documents={[]} />)
  expect(screen.getByText('当前会话还没有保存的计划。')).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
})
