import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { GitBridge } from '@pi-meme/contracts/desktop'
import { GitMenu } from '../src/ui/git-menu'

afterEach(cleanup)

test('非 Git 项目显示普通说明，不展示异常或分支操作', async () => {
  const getGitEnvironment = vi.fn().mockRejectedValue(new Error('当前目录不是 Git 仓库'))
  render(
    <GitMenu
      bridge={{ getGitEnvironment } as unknown as GitBridge}
      sessionKey="first"
      refreshToken={0}
      onSwitch={vi.fn()}
      onCreateBranch={vi.fn()}
      onCreateWorktree={vi.fn()}
    />,
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Git 分支与工作树' }).getAttribute('title')).toBe('当前项目未使用 Git'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Git 分支与工作树' }))
  expect(await screen.findByText('当前项目未使用 Git')).not.toBeNull()
  expect(screen.getByText('可以正常对话。分支和 Worktree 功能需要 Git 仓库。')).not.toBeNull()
  expect(screen.queryByText(/Error:/)).toBeNull()
  expect(screen.queryByRole('button', { name: '新建分支…' })).toBeNull()
})

test('切项目后清除上一项目的 Git 状态，忽略迟到响应', async () => {
  let finish!: (value: { cwd: string; root: string; dirty: boolean; branches: [] }) => void
  const getGitEnvironment = vi.fn((key: string) =>
    key === 'first'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.reject(new Error('当前目录不是 Git 仓库')),
  )
  const props = {
    bridge: { getGitEnvironment } as unknown as GitBridge,
    sessionKey: 'first',
    refreshToken: 0,
    onSwitch: vi.fn(),
    onCreateBranch: vi.fn(),
    onCreateWorktree: vi.fn(),
  }
  const { rerender } = render(<GitMenu {...props} />)
  rerender(<GitMenu {...props} sessionKey="second" />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Git 分支与工作树' }).getAttribute('title')).toBe('当前项目未使用 Git'),
  )
  finish({ cwd: '/tmp/first', root: '/tmp/first', dirty: false, branches: [] })
  fireEvent.click(screen.getByRole('button', { name: 'Git 分支与工作树' }))
  expect(await screen.findByText('当前项目未使用 Git')).not.toBeNull()
})
