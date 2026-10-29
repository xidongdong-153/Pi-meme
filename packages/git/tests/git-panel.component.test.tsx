import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { GitPanel, type GitReviewBridge } from '../src/ui/git-panel'
import { GitDiffViewer } from '../src/ui/git-diff-viewer'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'
import { projectReviewKey } from '../src/ui/git-review-preferences'

const patch = '@@ -1 +1 @@\n-old line\n+new line\n'
const changes: TurnChanges = {
  entryId: 'user-entry',
  undone: false,
  insertions: 2,
  deletions: 1,
  files: [
    { path: 'readme.md', patch: '@@ -0,0 +1 @@\n+readme\n', insertions: 1, deletions: 0 },
    { path: 'src/app.ts', patch, insertions: 1, deletions: 1 },
  ],
}
function bridge(overrides: Partial<GitReviewBridge> = {}): GitReviewBridge {
  return {
    review: async () => ({ cwd: '/repo', root: '/repo', branch: 'main', files: [], insertions: 0, deletions: 0 }),
    file: async () => ({ patch, before: 'old line\n', after: 'new line\n' }),
    options: async () => ({ branches: [], commits: [], hasMore: false }),
    turnFile: async (_, path) => ({ patch: changes.files.find((file) => file.path === path)!.patch }),
    ...overrides,
  }
}
beforeEach(() => localStorage.clear())
afterEach(cleanup)

test('首次默认未提交，读取当前工作区；记住项目范围', async () => {
  const queries: string[] = []
  const view = render(
    createElement(GitPanel, {
      cwd: '/repo',
      refreshToken: 0,
      bridge: bridge({
        review: async (query) => {
          queries.push(query.scope)
          return { cwd: '/repo', root: '/repo', files: [], insertions: 0, deletions: 0 }
        },
      }),
    }),
  )
  await waitFor(() => assert.equal(view.getByText('工作区干净').textContent, '工作区干净'))
  assert.deepEqual(queries, ['uncommitted'])
  cleanup()
  localStorage.setItem(projectReviewKey('/repo'), JSON.stringify({ scope: 'staged' }))
  render(
    createElement(GitPanel, {
      cwd: '/repo',
      refreshToken: 0,
      bridge: bridge({
        review: async (query) => {
          queries.push(query.scope)
          return { cwd: '/repo', root: '/repo', files: [], insertions: 0, deletions: 0 }
        },
      }),
    }),
  )
  await waitFor(() => assert.equal(queries[1], 'staged'))
})

test('聊天入口覆盖已记忆范围，允许多个文件展开与全部收起', async () => {
  localStorage.setItem(projectReviewKey('/repo'), JSON.stringify({ scope: 'staged' }))
  const view = render(
    createElement(GitPanel, {
      cwd: '/repo',
      refreshToken: 0,
      selectionRevision: 1,
      selectedPath: 'readme.md',
      turnChanges: changes,
      bridge: bridge(),
    }),
  )
  assert.ok(view.getByRole('button', { name: '变更范围：本轮' }))
  assert.ok(view.getByText('readme'))
  fireEvent.click(view.getByRole('button', { name: 'src/app.ts' }))
  await waitFor(() => assert.ok(view.getByText('new line')))
  assert.ok(view.getByText('readme'))
  fireEvent.click(view.getByRole('button', { name: '收起全部差异' }))
  assert.equal(view.queryByText('new line'), null)
  assert.equal(view.queryByText('readme'), null)
  fireEvent.click(view.getByRole('button', { name: '展开全部差异' }))
  assert.ok(view.getByText('new line'))
  assert.ok(view.getByText('readme'))
})

test('无 Git 仓库显示正常说明，Agent 轮次仍独立可读', async () => {
  let gitCalls = 0
  const api = bridge({
    review: async () => {
      gitCalls++
      return { cwd: '/repo', root: '/repo', files: [], insertions: 0, deletions: 0, error: 'not-repository' }
    },
  })
  const view = render(createElement(GitPanel, { cwd: '/repo', refreshToken: 0, turnChanges: changes, bridge: api }))
  await waitFor(() => assert.ok(view.getByText('当前项目未使用 Git。')))
  assert.equal(view.queryByRole('alert'), null)
  fireEvent.click(view.getByRole('button', { name: '查看 Agent 本轮修改' }))
  fireEvent.click(view.getByRole('button', { name: 'src/app.ts' }))
  await waitFor(() =>
    assert.ok(Array.from(view.container.querySelectorAll('code')).some((node) => node.textContent === 'new line')),
  )
  assert.equal(gitCalls, 1)
  cleanup()
  localStorage.setItem(projectReviewKey('/repo'), JSON.stringify({ scope: 'previous-turn' }))
  const previous = render(
    createElement(GitPanel, { cwd: '/repo', refreshToken: 0, previousTurnChanges: changes, bridge: api }),
  )
  assert.ok(previous.getByRole('button', { name: '变更范围：上一轮' }))
  fireEvent.click(previous.getByRole('button', { name: 'readme.md' }))
  assert.ok(previous.getByText('readme'))
  assert.equal(gitCalls, 1)
})

test('刷新保留展开状态并更新已展开文件的差异', async () => {
  let version = 1
  const api = bridge({
    review: async () => ({
      cwd: '/repo',
      root: '/repo',
      files: [{ path: 'a.txt', status: 'M', insertions: 1, deletions: 1, canOpen: true }],
      insertions: 1,
      deletions: 1,
    }),
    file: async () => ({ patch: `@@ -1 +1 @@\n-before\n+version ${version}\n` }),
  })
  const view = render(createElement(GitPanel, { cwd: '/repo', refreshToken: 0, bridge: api }))
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'a.txt' })))
  fireEvent.click(view.getByRole('button', { name: 'a.txt' }))
  await waitFor(() => assert.ok(view.getByText('version 1')))
  version = 2
  view.rerender(createElement(GitPanel, { cwd: '/repo', refreshToken: 1, bridge: api }))
  await waitFor(() => assert.ok(view.getByText('version 2')))
  assert.equal(view.getByRole('button', { name: 'a.txt' }).getAttribute('aria-expanded'), 'true')
})

test('展开上下文使用历史内容，缺失快照时禁用完整文件', () => {
  const props = {
    diff: '@@ -3 +3 @@\n-old\n+new\n',
    before: 'first\nsecond\nold\nlast\n',
    after: 'first\nsecond\nnew\nlast\n',
  }
  const view = render(createElement(GitDiffViewer, props))
  assert.equal(view.queryByText('first'), null)
  fireEvent.click(view.getByRole('button', { name: '展开完整文件' }))
  assert.ok(view.getByText('first'))
  assert.ok(view.getByText('last'))
  cleanup()
  const missing = render(createElement(GitDiffViewer, { diff: props.diff }))
  assert.equal(missing.getByRole('button', { name: '展开完整文件' }).hasAttribute('disabled'), true)
  assert.ok(missing.getByText(/历史上下文不可用/))
})
