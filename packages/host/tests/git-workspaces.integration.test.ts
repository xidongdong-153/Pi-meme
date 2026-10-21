import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, describe } from 'vitest'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { runGit } from '@pi-meme/git/server/git-service'
import type { Connection, GitEnvironment, GitWorktreeResult, SessionSelectionResult } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'
import { HostCollaborationBridge } from '@pi-meme/subagents/server/coordinator'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { createHost } from '../src/service'

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'host-git-workspaces-')))
  const repo = path.join(directory, 'repo')
  const dataRoot = path.join(directory, 'data')
  await mkdir(repo)
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.name', 'Test'])
  await runGit(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(repo, 'file.txt'), 'initial\n')
  await runGit(repo, ['add', 'file.txt'])
  await runGit(repo, ['commit', '-qm', 'initial'])
  const host = await createHost({ dataRoot, testCredentials: true })
  const rpc = async <T>(method: string, args: unknown[] = [], sessionId?: string, clientId = 'client') => {
    const response = await host.rpc({ requestId: crypto.randomUUID(), clientId, method, args, sessionId })
    if (response.error) throw new Error(response.error.message)
    return response.result as T
  }
  const selected = await rpc<SessionSelectionResult>('workspace:select', [{ kind: 'project', cwd: repo }])
  assert.equal(selected.cancelled, false)
  if (selected.cancelled) throw new Error('项目选择失败')
  return { directory, repo, dataRoot, host, rpc, key: selected.snapshot.connection.sessionKey! }
}

test('Git 切分支创建新会话，拒绝 dirty、无效分支与其他 Worktree 占用，gate 阻止新执行', async () => {
  const { directory, repo, host, rpc, key } = await fixture()
  try {
    const initial = await rpc<GitEnvironment>('git:environment', [key], key)
    assert.equal(initial.branch, 'main')
    await writeFile(path.join(repo, 'dirty.txt'), 'dirty')
    await assert.rejects(rpc('git:create-branch', [key, 'feature', 'refs/heads/main'], key), /未提交更改/)
    assert.equal((await rpc<Connection>('pi:connection')).sessionKey, key)
    await rm(path.join(repo, 'dirty.txt'))
    await assert.rejects(rpc('git:create-branch', [key, 'bad branch', 'refs/heads/main'], key), /分支名称无效/)
    let entered!: () => void
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const retire = host.pi.retireCheckout.bind(host.pi)
    host.pi.retireCheckout = async (matches) => {
      entered()
      await gate
      await retire(matches)
    }
    const switching = rpc<SessionSelectionResult>('git:create-branch', [key, 'feature', 'HEAD'], key)
    await pending
    await assert.rejects(host.pi.prompt(key, '不能发送'), /正在切换 Git 分支/)
    release()
    const selection = await switching
    assert.equal(selection.cancelled, false)
    if (selection.cancelled) return
    const next = selection.snapshot.connection.sessionKey!
    assert.notEqual(next, key)
    assert.equal((await rpc<GitEnvironment>('git:environment', [next], next)).branch, 'feature')
    const elsewhere = path.join(directory, 'elsewhere')
    await runGit(repo, ['worktree', 'add', elsewhere, 'main'])
    const environment = await rpc<GitEnvironment>('git:environment', [next], next)
    assert.equal(environment.branches.find((branch) => branch.name === 'main')?.occupiedBy, elsewhere)
    await assert.rejects(rpc('git:switch-branch', [next, 'refs/heads/main'], next), /其他 Worktree 使用/)
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Worktree 使用已选提交，不带未提交更改，保存真实 cwd 并归来源项目，删除预览包含其会话', async () => {
  const { directory, repo, dataRoot, host, rpc, key } = await fixture()
  try {
    const environment = await rpc<GitEnvironment>('git:environment', [key], key)
    await writeFile(path.join(repo, 'file.txt'), 'uncommitted\n')
    const result = await rpc<GitWorktreeResult>('git:create-worktree', [key, 'HEAD'], key)
    assert.ok(result.checkoutRoot.startsWith(path.join(dataRoot, storageLayoutRelativePaths.worktreesDirectory)))
    assert.equal(result.headSha, environment.headSha)
    assert.equal(result.sourceProjectCwd, repo)
    assert.equal(await readFile(path.join(result.cwd, 'file.txt'), 'utf8'), 'initial\n')
    assert.equal(await runGit(result.cwd, ['symbolic-ref', '-q', 'HEAD']).catch(() => undefined), undefined)
    assert.equal(result.selection.cancelled, false)
    if (result.selection.cancelled) return
    assert.equal(result.selection.snapshot.connection.cwd, result.cwd)
    assert.equal(result.selection.snapshot.connection.sourceProjectCwd, repo)
    const next = result.selection.snapshot.connection.sessionKey!
    const appSession = await host.control.sessionForRuntime(next)
    assert.equal(appSession.cwd, result.cwd)
    assert.ok(appSession.project)
    assert.equal((await host.app.projects.get(appSession.project)).cwd, repo)
    assert.equal((await host.app.files.read(appSession, 'file.txt')).content, 'initial\n')
    const sessionDirectory = createPiRuntimePaths(dataRoot).sessionDirectory(result.cwd)
    await mkdir(sessionDirectory, { recursive: true })
    const sessionFile = path.join(sessionDirectory, '2026-10-10T00-00-00-000Z_worktree-test.jsonl')
    await writeFile(
      sessionFile,
      `${[
        { type: 'session', id: 'worktree-test', cwd: result.cwd, version: 3, timestamp: '2026-10-10T00:00:00.000Z' },
        {
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-10-10T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Worktree 任务' }], timestamp: 1791590401000 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    )
    await rpc('session:rename', [sessionFile, 'Worktree 会话'])
    const sessions = await rpc<PiSessionsSnapshot>('pi:sessions')
    assert.equal(
      sessions.projects.some((project) => project.cwd === result.cwd),
      false,
    )
    const project = sessions.projects.find((entry) => entry.cwd === repo)
    const summary = project?.sessions.find((session) => session.id === 'worktree-test')
    assert.equal(summary?.cwd, result.cwd)
    assert.equal(summary?.sourceProjectCwd, repo)
    const preview = await rpc<{ paths: string[] }>('project:delete-preview', [repo])
    assert.ok(preview.paths.includes(sessionFile))
    const saved = JSON.parse(await readFile(path.join(dataRoot, storageLayoutRelativePaths.projectsFile), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.worktrees[0].checkoutRoot, result.checkoutRoot)
    const second = await rpc<GitWorktreeResult>('git:create-worktree', [next, 'refs/heads/main'], next)
    assert.equal(second.sourceProjectCwd, repo)
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Worktree 来源保存失败不会创建 checkout，创建后选择失败仍返回路径与记录', async () => {
  const { directory, repo, dataRoot, host, rpc, key } = await fixture()
  try {
    const file = path.join(dataRoot, `${storageLayoutRelativePaths.projectsFile}.tmp`)
    await mkdir(path.dirname(file), { recursive: true })
    await mkdir(file)
    await assert.rejects(rpc('git:create-worktree', [key, 'refs/heads/main'], key), /EISDIR/)
    assert.equal((await runGit(repo, ['worktree', 'list', '--porcelain'])).stdout.split('worktree ').length, 2)
    await rm(file, { recursive: true })
    host.pi.selectWorkspaceDirectory = async () => {
      throw new Error('选择失败')
    }
    const result = await rpc<GitWorktreeResult>('git:create-worktree', [key, 'refs/heads/main'], key)
    assert.equal(result.selection.cancelled, true)
    assert.match(result.selectionError!, /已创建.*选择失败/)
    assert.equal(await readFile(path.join(result.cwd, 'file.txt'), 'utf8'), 'initial\n')
    const saved = JSON.parse(await readFile(path.join(dataRoot, storageLayoutRelativePaths.projectsFile), 'utf8'))
    assert.equal(saved.worktrees.length, 1)
    assert.equal((await rpc<Connection>('pi:connection')).sessionKey, key)
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Worktree checkout 已创建但 post-checkout 失败时保留目录与来源记录', async () => {
  const { directory, repo, dataRoot, host, rpc, key } = await fixture()
  try {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
    await writeFile(hook, '#!/bin/sh\nexit 1\n')
    await chmod(hook, 0o755)
    const result = await rpc<GitWorktreeResult>('git:create-worktree', [key, 'refs/heads/main'], key)
    assert.equal(result.selection.cancelled, true)
    assert.match(result.selectionError!, /目录与来源记录已保留/)
    assert.equal(await readFile(path.join(result.checkoutRoot, 'file.txt'), 'utf8'), 'initial\n')
    assert.equal(
      JSON.parse(await readFile(path.join(dataRoot, storageLayoutRelativePaths.projectsFile), 'utf8')).worktrees[0]
        .checkoutRoot,
      result.checkoutRoot,
    )
    assert.equal((await rpc<Connection>('pi:connection')).sessionKey, key)
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

describe('Worktree 创建后补充快照或凭据写入失败仍返回路径，保留旧会话选择', () => {
  for (const phase of ['snapshot', 'credentials'] as const) {
    test(phase, async () => {
      const { directory, dataRoot, host, rpc, key } = await fixture()
      const snapshot = HostCollaborationBridge.prototype.snapshot
      const storage = host.credentials as typeof host.credentials & { flush?: () => Promise<void> }
      const flush = storage.flush
      try {
        if (phase === 'snapshot') {
          HostCollaborationBridge.prototype.snapshot = async function (sessionKey) {
            if (host.pi.readSessionBinding(sessionKey).cwd.includes(`${path.sep}worktrees${path.sep}`))
              throw new Error('补充快照失败')
            return snapshot.call(this, sessionKey)
          }
        } else
          storage.flush = async () => {
            throw new Error('凭据写入失败')
          }
        const result = await rpc<GitWorktreeResult>('git:create-worktree', [key, 'HEAD'], key)
        assert.equal(result.selection.cancelled, true)
        assert.match(result.selectionError!, /目录与来源记录已保留/)
        assert.equal(await readFile(path.join(result.cwd, 'file.txt'), 'utf8'), 'initial\n')
        assert.equal(
          JSON.parse(await readFile(path.join(dataRoot, storageLayoutRelativePaths.projectsFile), 'utf8')).worktrees[0]
            .checkoutRoot,
          result.checkoutRoot,
        )
        storage.flush = flush
        assert.equal((await rpc<Connection>('pi:connection')).sessionKey, key)
      } finally {
        HostCollaborationBridge.prototype.snapshot = snapshot
        storage.flush = flush
        await host.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
})

test('Worktree 补充快照期间另一客户端选择项目，不清理尚未发布的空会话', async () => {
  const { directory, repo, host, rpc, key } = await fixture()
  const snapshot = HostCollaborationBridge.prototype.snapshot
  let entered!: () => void
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let creation: Promise<GitWorktreeResult> | undefined
  try {
    HostCollaborationBridge.prototype.snapshot = async function (sessionKey) {
      if (host.pi.readSessionBinding(sessionKey).cwd.includes(`${path.sep}worktrees${path.sep}`)) {
        entered()
        await gate
      }
      return snapshot.call(this, sessionKey)
    }
    creation = rpc<GitWorktreeResult>('git:create-worktree', [key, 'HEAD'], key)
    await waiting
    const other = await rpc<SessionSelectionResult>(
      'workspace:select',
      [{ kind: 'project', cwd: repo }],
      undefined,
      'other',
    )
    assert.equal(other.cancelled, false)
    release()
    const result = await creation
    assert.equal(result.selection.cancelled, false)
    const current = await rpc<Connection>('pi:connection')
    assert.equal(current.cwd, result.cwd)
    const visible = await rpc<import('@pi-meme/contracts/desktop').Snapshot>('pi:snapshot')
    assert.equal(visible.connection.cwd, result.cwd)
  } finally {
    release()
    await creation
    HostCollaborationBridge.prototype.snapshot = snapshot
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
