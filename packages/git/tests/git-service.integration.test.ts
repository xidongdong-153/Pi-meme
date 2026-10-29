import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { getGitDiff, getGitSnapshot, runGit } from '../src/server/git-service'
import { getGitReview, getGitReviewFile, getGitReviewOptions } from '../src/server/git-review'

function git(cwd: string, ...args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} 退出码 ${code}`))))
  })
}

test('Git 快照识别暂存、未暂存、未跟踪、二进制和中文空格路径', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pi-desktop-git-'))
  const repo = path.join(base, 'repo')
  try {
    await mkdir(repo)
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.email', 'test@example.com')
    await git(repo, 'config', 'user.name', 'Test')
    await writeFile(path.join(repo, 'base file.txt'), 'base\n')
    await git(repo, 'add', '--', 'base file.txt')
    await git(repo, 'commit', '-qm', 'initial')

    await writeFile(path.join(repo, 'base file.txt'), 'base\nstaged\n')
    await git(repo, 'add', '--', 'base file.txt')
    await writeFile(path.join(repo, 'base file.txt'), 'base\nworking\n')
    const unicodePath = '新文件 with space.txt'
    await writeFile(path.join(repo, unicodePath), '新内容\n')
    await writeFile(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 255]))

    const snapshot = await getGitSnapshot(repo)
    assert.equal(snapshot.error, undefined)
    assert.equal(snapshot.root, await realpath(repo))
    assert.equal(
      snapshot.files.some((file) => file.path === 'base file.txt' && file.kind === 'staged'),
      true,
    )
    assert.equal(
      snapshot.files.some((file) => file.path === 'base file.txt' && file.kind === 'unstaged'),
      true,
    )
    assert.equal(
      snapshot.files.some((file) => file.path === unicodePath && file.kind === 'untracked'),
      true,
    )
    assert.equal(snapshot.insertions, 1)
    assert.equal(snapshot.deletions, 0)
    assert.equal(await getGitDiff(repo, unicodePath, 'untracked'), '新内容\n')
    assert.equal(await getGitDiff(repo, 'image.bin', 'untracked'), '二进制文件，不提供文本预览。')
    await assert.rejects(getGitDiff(repo, '../outside', 'untracked'), /不在变更列表中/)

    await git(repo, 'mv', 'base file.txt', 'renamed file.txt')
    const renamed = await getGitSnapshot(repo)
    assert.equal(
      renamed.files.some((file) => file.path === 'renamed file.txt' && file.kind === 'staged'),
      true,
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('审阅范围区分暂存、工作区、提交和共同祖先，并读取真实上下文', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'pi-review-'))
  try {
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'config', 'user.email', 'test@example.com')
    await git(repo, 'config', 'user.name', 'Test')
    await writeFile(path.join(repo, '文件 with space.ts'), 'base\n')
    await git(repo, 'add', '.')
    const unborn = await getGitReview(repo, { scope: 'staged' })
    assert.equal(unborn.insertions, 1)
    await git(repo, 'commit', '-qm', 'initial')
    const first = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    assert.equal((await getGitReview(repo, { scope: 'commit', ref: first })).insertions, 1)
    await writeFile(path.join(repo, '文件 with space.ts'), 'base\nstaged\n')
    await git(repo, 'add', '.')
    await writeFile(path.join(repo, '文件 with space.ts'), 'base\nworking\n')
    await writeFile(path.join(repo, 'new.md'), 'new\n')
    await writeFile(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2]))
    const staged = await getGitReview(repo, { scope: 'staged' })
    assert.deepEqual([staged.insertions, staged.deletions, staged.files.length], [1, 0, 1])
    const unstaged = await getGitReview(repo, { scope: 'unstaged' })
    assert.deepEqual([unstaged.insertions, unstaged.deletions], [2, 1])
    const all = await getGitReview(repo, { scope: 'uncommitted' })
    assert.deepEqual([all.insertions, all.deletions], [2, 0])
    const content = await getGitReviewFile(repo, { query: { scope: 'unstaged' }, path: '文件 with space.ts' })
    assert.equal(content.before, 'base\nstaged\n')
    assert.equal(content.after, 'base\nworking\n')
    assert.match(
      (await getGitReviewFile(repo, { query: { scope: 'uncommitted' }, path: 'image.bin' })).notice!,
      /二进制/,
    )
    await assert.rejects(getGitReviewFile(repo, { query: { scope: 'uncommitted' }, path: '../outside' }), /变更列表/)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'working change')
    await git(repo, 'switch', '-qc', 'feature')
    await git(repo, 'mv', '文件 with space.ts', 'renamed.ts')
    await git(repo, 'commit', '-qm', 'rename')
    const renameSha = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    await git(repo, 'switch', 'main')
    await writeFile(path.join(repo, 'main-only.txt'), 'main only\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'main only')
    await git(repo, 'switch', 'feature')
    await writeFile(path.join(repo, 'renamed.ts'), 'uncommitted\n')
    const branch = await getGitReview(repo, { scope: 'branch', ref: 'refs/heads/main' })
    assert.equal(branch.files.length, 1)
    assert.equal(branch.files[0]?.oldPath, '文件 with space.ts')
    const history = await getGitReviewFile(repo, { query: { scope: 'commit', ref: renameSha }, path: 'renamed.ts' })
    assert.equal(history.before, 'base\nworking\n')
    assert.equal(history.after, 'base\nworking\n')
    const options = await getGitReviewOptions(repo, { search: 'rename' })
    assert.equal(options.commits[0]?.sha, renameSha)
    assert.ok(options.branches.some((item) => item.ref === 'refs/heads/main'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('Git 首次提交前可统计暂存文件，支持 worktree 和非仓库错误状态', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pi-desktop-git-empty-'))
  const repo = path.join(base, 'repo')
  const worktree = path.join(base, 'worktree')
  const outside = path.join(base, 'outside')
  try {
    await mkdir(repo)
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.email', 'test@example.com')
    await git(repo, 'config', 'user.name', 'Test')
    await writeFile(path.join(repo, 'first.txt'), 'one\ntwo\n')
    await git(repo, 'add', '--', 'first.txt')
    const unborn = await getGitSnapshot(repo)
    assert.equal(unborn.error, undefined)
    assert.equal(unborn.insertions, 2)
    await git(repo, 'commit', '-qm', 'initial')
    await git(repo, 'worktree', 'add', '-qb', 'other', worktree)
    const fromWorktree = await getGitSnapshot(worktree)
    assert.equal(fromWorktree.root, await realpath(worktree))
    await mkdir(outside)
    assert.equal((await getGitSnapshot(outside)).error, 'not-repository')
    assert.equal((await getGitReview(outside, { scope: 'uncommitted' })).error, 'not-repository')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
