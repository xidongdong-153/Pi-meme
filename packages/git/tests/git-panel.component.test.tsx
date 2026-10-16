import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { GitPanel, type GitTurnFile } from '../src/ui/git-panel'

const patch = '@@ -1 +1 @@\n-old line\n+new line\n'
const changes: GitTurnFile[] = [
  { path: 'readme.md', entries: [{ toolCallId: 'write-1', kind: 'write' }] },
  { path: 'src/app.ts', entries: [{ toolCallId: 'edit-1', kind: 'edit', patch }] },
]

afterEach(cleanup)

test('默认展示本轮差异，切到工作区后才读取 Git', async () => {
  let snapshots = 0
  const view = render(
    createElement(GitPanel, {
      cwd: '/repo',
      refreshToken: 0,
      turnChanges: changes,
      bridge: {
        getGitSnapshot: async () => {
          snapshots += 1
          return { cwd: '/repo', root: '/repo', branch: 'main', files: [], insertions: 0, deletions: 0 }
        },
        getGitDiff: async () => '',
      },
    }),
  )
  assert.equal(snapshots, 0)
  assert.equal(view.getByRole('button', { name: '本轮' }).getAttribute('aria-pressed'), 'true')
  assert.equal(view.getByText('覆盖写入，没有修改前内容').textContent, '覆盖写入，没有修改前内容')
  fireEvent.click(view.getByRole('button', { name: 'src/app.ts' }))
  assert.ok(view.getByText('new line'))
  fireEvent.click(view.getByRole('button', { name: '工作区' }))
  await waitFor(() => {
    assert.equal(snapshots, 1)
    assert.equal(view.getByText('工作区干净').textContent, '工作区干净')
  })
})
