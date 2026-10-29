import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { GitPanel } from '../src/ui/git-panel'
import type { TurnChanges } from '@pi-meme/contracts/turn-changes'

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
  fireEvent.click(view.getByRole('button', { name: 'readme.md' }))
  assert.ok(view.getByText('readme'))
  fireEvent.click(view.getByRole('button', { name: 'src/app.ts' }))
  assert.ok(view.getByText('new line'))
  fireEvent.click(view.getByRole('button', { name: '工作区' }))
  await waitFor(() => {
    assert.equal(snapshots, 1)
    assert.equal(view.getByText('工作区干净').textContent, '工作区干净')
  })
})
