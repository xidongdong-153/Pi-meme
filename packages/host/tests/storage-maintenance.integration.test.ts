import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { cacheSize, clearCaches } from '../src/storage/cache'
import { migrateStorage, previewMigration } from '../src/storage/migrate'
import { assertActiveDataRoot, lockDataRoot, storageOwnerFile } from '../src/data-root'
import { createHost } from '../src/service'
import { readJson, writeJson } from '../src/storage/files'
import { workspaceKey } from '@pi-meme/pi-runtime/runtime-paths'
import { ResourceStore } from '@pi-meme/resources/server/resource-store'
import { runGit } from '@pi-meme/git/server/git-service'

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-meme-storage-')))
  const source = path.join(directory, 'source')
  const target = path.join(directory, 'target')
  const anchor = path.join(directory, 'desktop')
  await Promise.all([source, target, anchor].map((folder) => mkdir(folder)))
  await writeFile(path.join(source, 'host-id'), 'storage-fixture')
  return { directory, source, target, anchor, dispose: () => rm(directory, { recursive: true, force: true }) }
}
function migration(input: Awaited<ReturnType<typeof fixture>>, commit = async () => {}) {
  return migrateStorage({ ...input, id: 'fixture-job', hostId: 'storage-fixture', progress: () => {}, commit })
}

test('只清理固定缓存，保留凭据、会话、快照、请求去重和桌面定位文件', async () => {
  const f = await fixture()
  try {
    for (const file of [
      'sessions-cache.json',
      'remote-services.json',
      'auth.json',
      'control.json',
      'requests/one',
      'sessions/one.jsonl',
      'resources/snapshots/one/SKILL.md',
    ]) {
      await mkdir(path.dirname(path.join(f.source, file)), { recursive: true })
      await writeFile(path.join(f.source, file), file)
    }
    await mkdir(path.join(f.anchor, 'GPUCache'))
    await writeFile(path.join(f.anchor, 'GPUCache/data'), 'cache')
    await writeFile(path.join(f.anchor, 'storage-location.json'), 'keep')
    assert.ok((await cacheSize(f.source, f.anchor)) > 0)
    await clearCaches(f.source, f.anchor)
    assert.equal(await cacheSize(f.source, f.anchor), 0)
    await clearCaches(f.source, f.anchor)
    for (const file of [
      'auth.json',
      'control.json',
      'requests/one',
      'sessions/one.jsonl',
      'resources/snapshots/one/SKILL.md',
    ])
      assert.equal(await readFile(path.join(f.source, file), 'utf8'), file)
    assert.equal(await readFile(path.join(f.anchor, 'storage-location.json'), 'utf8'), 'keep')
  } finally {
    await f.dispose()
  }
})

test('缓存中的末端和嵌套链接不能导致外部文件被清理', async () => {
  const f = await fixture()
  try {
    const outside = path.join(f.directory, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'keep'), 'keep')
    await symlink(outside, path.join(f.anchor, 'GPUCache'))
    await assert.rejects(clearCaches(f.source, f.anchor), /链接/)
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'keep')
    await rm(path.join(f.anchor, 'GPUCache'))
    await mkdir(path.join(f.anchor, 'GPUCache'))
    await symlink(outside, path.join(f.anchor, 'GPUCache/redirect'))
    await assert.rejects(clearCaches(f.source, f.anchor), /链接/)
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'keep')
  } finally {
    await f.dispose()
  }
})

test('拒绝非空、父子嵌套、链接和已有 Host 锁的目标', async () => {
  const f = await fixture()
  try {
    assert.ok((await previewMigration(f.source, f.target, f.anchor)).availableBytes > 0)
    await assert.rejects(previewMigration(f.source, f.target, f.source), /启动目录/)
    await writeFile(path.join(f.target, 'user-file'), 'keep')
    await assert.rejects(previewMigration(f.source, f.target, f.anchor), /空文件夹/)
    await rm(path.join(f.target, 'user-file'))
    await mkdir(path.join(f.source, 'nested'))
    await assert.rejects(previewMigration(f.source, path.join(f.source, 'nested'), f.anchor), /分离/)
    const linked = path.join(f.directory, 'link')
    await symlink(f.target, linked)
    await assert.rejects(previewMigration(f.source, linked, f.anchor), /符号链接/)
    const release = await lockDataRoot(f.source)
    try {
      await assert.rejects(migration(f), /已有 Host/)
    } finally {
      await release()
    }
    assert.deepEqual(await readdir(f.target), [])
  } finally {
    await f.dispose()
  }
})

test('完整迁移保留身份、权限、分支、侧栏排序和历史正文，修复 cwd 哈希', async () => {
  const f = await fixture()
  try {
    const cwd = path.join(f.source, 'standalone-workspaces', 'example')
    await mkdir(cwd, { recursive: true })
    const oldKey = workspaceKey(cwd)
    const newCwd = path.join(f.target, 'standalone-workspaces', 'example')
    const newKey = workspaceKey(newCwd)
    const oldFile = path.join(f.source, 'sessions', oldKey, 'one.jsonl')
    const newFile = path.join(f.target, 'sessions', newKey, 'one.jsonl')
    await mkdir(path.dirname(oldFile), { recursive: true })
    const content = `${[
      { type: 'session', id: 'stable-session', cwd, parentSession: oldFile },
      { type: 'message', message: { role: 'user', content: `保留历史路径 ${cwd}` } },
      {
        type: 'custom',
        customType: 'pi-meme.skill-use',
        data: { id: 'stable-skill', path: path.join(f.source, 'resources/snapshots/old/SKILL.md') },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n')}\n`
    await writeFile(oldFile, content)
    await writeFile(path.join(f.source, 'auth.json'), '{"fixture":"not-a-real-secret"}', { mode: 0o600 })
    await chmod(path.join(f.source, 'auth.json'), 0o600)
    await writeJson(path.join(f.source, 'agent-permissions.json'), { [oldFile]: 'read-only' })
    const item = JSON.stringify(['local', 'session', oldFile])
    await writeJson(path.join(f.source, 'settings.json'), {
      themeId: 'dark',
      pinnedPaths: [oldFile],
      sidebar: { orders: { pinned: [item] } },
    })
    await writeJson(path.join(f.source, 'control.json'), {
      version: 2,
      sessions: [{ sessionId: 'stable-id', cwd, sessionFile: oldFile }],
      projects: [],
    })
    await writeJson(path.join(f.source, 'workspaces', oldKey, 'resources.json'), { 'stable-skill': { enabled: false } })
    let committed = false
    await migration(f, async () => {
      committed = true
    })
    assert.equal(committed, true)
    const rows = (await readFile(newFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(rows[0].id, 'stable-session')
    assert.equal(rows[0].cwd, newCwd)
    assert.equal(rows[0].parentSession, newFile)
    assert.equal(rows[1].message.content, `保留历史路径 ${cwd}`)
    assert.equal(rows[2].data.path, path.join(f.target, 'resources/snapshots/old/SKILL.md'))
    assert.deepEqual(await readJson(path.join(f.target, 'agent-permissions.json')), { [newFile]: 'read-only' })
    const settings = (await readJson<{ pinnedPaths: string[]; sidebar: { orders: { pinned: string[] } } }>(
      path.join(f.target, 'settings.json'),
    ))!
    assert.deepEqual(settings.pinnedPaths, [newFile])
    assert.deepEqual(settings.sidebar.orders.pinned, [JSON.stringify(['local', 'session', newFile])])
    const control = (await readJson<{ sessions: Array<{ sessionId: string; cwd: string; sessionFile: string }> }>(
      path.join(f.target, 'control.json'),
    ))!
    assert.deepEqual(control.sessions, [{ sessionId: 'stable-id', cwd: newCwd, sessionFile: newFile }])
    assert.deepEqual(await readJson(path.join(f.target, 'workspaces', newKey, 'resources.json')), {
      'stable-skill': { enabled: false },
    })
    assert.equal((await stat(path.join(f.target, 'auth.json'))).mode & 0o777, 0o600)
    assert.equal(await readFile(oldFile, 'utf8'), content)
    await assert.rejects(assertActiveDataRoot(f.source), /迁移/)
    await assertActiveDataRoot(f.target)
  } finally {
    await f.dispose()
  }
})

test('技能迁移后保留资源 ID、策略与导入来源，不出现重复资源', async () => {
  const f = await fixture()
  try {
    const store = new ResourceStore(f.source, { hostId: 'storage-fixture' })
    await store.init()
    const catalog = await store.import({
      name: 'example',
      content: '---\nname: example\ndescription: 测试技能\n---\n# 测试\n',
    })
    const item = catalog.items.find((entry) => entry.name === 'example')!
    await store.setPolicy({ id: item.id, scope: 'host', invocation: 'manual', enabled: false })
    await migration(f)
    const moved = new ResourceStore(f.target, { hostId: 'storage-fixture' })
    await moved.init()
    const next = await moved.catalog()
    assert.equal(next.items.filter((entry) => entry.name === 'example').length, 1)
    const skill = next.items.find((entry) => entry.name === 'example')!
    assert.equal(skill.id, item.id)
    assert.equal(skill.enabled, false)
    assert.equal(skill.invocation, 'manual')
    assert.equal(skill.sourcePath, path.join(f.target, 'skills/example/SKILL.md'))
  } finally {
    await f.dispose()
  }
})

test('目录配置提交失败恢复旧 Worktree 登记，成功后新 Worktree 可用', async () => {
  const f = await fixture()
  try {
    const repository = path.join(f.directory, 'repository')
    await mkdir(repository)
    await runGit(repository, ['init', '--quiet'])
    await runGit(repository, [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ])
    const from = path.join(f.source, 'worktrees/one')
    const to = path.join(f.target, 'worktrees/one')
    await runGit(repository, ['worktree', 'add', '--detach', from, 'HEAD'])
    await writeFile(path.join(from, 'untracked.txt'), 'keep')
    await writeJson(path.join(f.source, 'projects.json'), {
      version: 1,
      projects: [],
      worktrees: [{ cwd: from, checkoutRoot: from, sourceProjectCwd: repository, baseRef: 'HEAD', headSha: 'fixture' }],
    })
    await assert.rejects(
      migration(f, async () => {
        throw new Error('模拟配置写入失败')
      }),
      /配置写入失败/,
    )
    await assertActiveDataRoot(f.source)
    assert.ok((await runGit(repository, ['worktree', 'list', '--porcelain'])).stdout.includes(`worktree ${from}`))
    await migration(f)
    assert.ok((await runGit(repository, ['worktree', 'list', '--porcelain'])).stdout.includes(`worktree ${to}`))
    assert.equal(await readFile(path.join(to, 'untracked.txt'), 'utf8'), 'keep')
  } finally {
    await f.dispose()
  }
})

test('校验失败不提交，来源与用户后来加入的文件都不删除', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.source, 'payload'), 'original')
    let commits = 0
    await assert.rejects(
      migrateStorage({
        ...f,
        id: 'fixture-job',
        hostId: 'storage-fixture',
        commit: async () => {
          commits++
        },
        progress: (value) => {
          if (value.stage === 'verifying') writeFileSync(path.join(f.target, 'payload'), 'corrupted')
        },
      }),
      /校验失败/,
    )
    assert.equal(commits, 0)
    assert.equal(await readFile(path.join(f.source, 'payload'), 'utf8'), 'original')
    await assertActiveDataRoot(f.source)
    await assert.rejects(assertActiveDataRoot(f.target), /尚未提交/)
    await writeFile(path.join(f.target, 'new-user-file'), 'keep')
    await assert.rejects(migration(f), /本任务之外/)
    assert.equal(await readFile(path.join(f.target, 'new-user-file'), 'utf8'), 'keep')
  } finally {
    await f.dispose()
  }
})

test('真实进程中断保留任务归属和原数据，移除已死 fixture 锁后可续传', async () => {
  const f = await fixture()
  await writeFile(path.join(f.source, 'payload'), 'interrupted-data')
  const ready = path.join(f.directory, 'ready')
  const script = `import { migrateStorage } from ${JSON.stringify(path.resolve('packages/host/src/storage/migrate.ts'))};
    import { writeFileSync } from 'node:fs';
    await migrateStorage({ ...${JSON.stringify({ source: f.source, target: f.target, anchor: f.anchor, id: 'fixture-job', hostId: 'storage-fixture' })},
      commit: async () => {}, progress: value => { if (value.stage === 'copying') { writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } } });`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'ignore' })
  try {
    await vi.waitFor(async () => assert.equal(await readFile(ready, 'utf8'), 'ready'), { timeout: 10000 })
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    await assert.rejects(assertActiveDataRoot(f.source), /维护/)
    await assert.rejects(assertActiveDataRoot(f.target), /尚未提交/)
    // 只移除本测试已确认退出的子进程锁，避免等待生产的 30 秒陈旧锁窗口。
    for (const root of [f.source, f.target]) await rm(path.join(root, 'host.lock'), { recursive: true, force: true })
    await migration(f)
    assert.equal(await readFile(path.join(f.target, 'payload'), 'utf8'), 'interrupted-data')
    assert.equal(await readFile(path.join(f.source, 'payload'), 'utf8'), 'interrupted-data')
    assert.equal((await readJson<{ stage: string }>(path.join(f.target, storageOwnerFile)))!.stage, 'committed')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await f.dispose()
  }
})

test('无资源状态文件的松散与内置技能迁移后身份不变，可删除后重新创建', async () => {
  const f = await fixture()
  try {
    for (const folder of ['skills/loose', 'builtin-resources/skills/builtin']) {
      await mkdir(path.join(f.source, folder), { recursive: true })
      await writeFile(
        path.join(f.source, folder, 'SKILL.md'),
        `---\nname: ${path.basename(folder)}\ndescription: 迁移测试\n---\n正文\n`,
      )
    }
    const original = new ResourceStore(f.source, { hostId: 'storage-fixture' })
    await original.init()
    const previous = await original.catalog()
    await migration(f)
    const moved = new ResourceStore(f.target, { hostId: 'storage-fixture' })
    await moved.init()
    const next = await moved.catalog()
    assert.deepEqual(
      next.items.map((item) => [item.name, item.id]),
      previous.items.map((item) => [item.name, item.id]),
    )
    const loose = next.items.find((item) => item.name === 'loose')!
    await moved.remove(loose.id)
    await moved.import({ name: 'loose', content: '---\nname: loose\ndescription: 新正文\n---\n重新创建\n' })
    assert.equal((await moved.catalog()).items.filter((item) => item.name === 'loose').length, 1)
  } finally {
    await f.dispose()
  }
})

test('指向重分组会话的链接随哈希改写，外部链接仍指向原文件', async () => {
  const f = await fixture()
  try {
    const cwd = path.join(f.source, 'standalone-workspaces/one')
    await mkdir(cwd, { recursive: true })
    const original = path.join(f.source, 'sessions', workspaceKey(cwd), 'one.jsonl')
    await mkdir(path.dirname(original), { recursive: true })
    await writeFile(original, `${JSON.stringify({ type: 'session', id: 'one', cwd })}\n`)
    await symlink(original, path.join(cwd, 'saved-session'))
    const outside = path.join(f.directory, 'outside')
    await writeFile(outside, 'external')
    await symlink(path.relative(cwd, outside), path.join(cwd, 'external'))
    await migration(f)
    assert.equal(
      (
        JSON.parse((await readFile(path.join(f.target, 'standalone-workspaces/one/saved-session'), 'utf8')).trim()) as {
          id: string
        }
      ).id,
      'one',
    )
    assert.equal(await readFile(path.join(f.target, 'standalone-workspaces/one/external'), 'utf8'), 'external')
  } finally {
    await f.dispose()
  }
})

test('中断后的任务日志损坏时保留来源维护标记，不绕过恢复启动旧 Host', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      migrateStorage({
        ...f,
        id: 'fixture-job',
        hostId: 'storage-fixture',
        commit: async () => {},
        progress: (value) => {
          if (value.stage === 'copying') throw new Error('模拟中断')
        },
      }),
      /模拟中断/,
    )
    const file = path.join(f.target, storageOwnerFile)
    const journal = await readJson<Record<string, unknown>>(file)
    await writeJson(file, { ...journal, stage: 'corrupted' })
    await writeJson(path.join(f.source, '.pi-meme-relocated.json'), {
      id: 'fixture-job',
      target: f.target,
      status: 'maintaining',
    })
    await assert.rejects(migration(f), /状态无效/)
    await assert.rejects(assertActiveDataRoot(f.source), /维护/)
  } finally {
    await f.dispose()
  }
})

test('存储信息是只读 RPC；本机维护拒绝活动终端，关闭后阻止新写入', async () => {
  const f = await fixture()
  const host = await createHost({ dataRoot: f.source, testCredentials: true })
  try {
    const result = await host.rpc({ clientId: 'storage', requestId: 'info', method: 'host:storage-info', args: [] })
    assert.deepEqual(result.result, { hostId: 'storage-fixture', dataRoot: f.source })
    const project = await host.app.projects.register({ cwd: f.directory }, { idempotencyKey: 'project' })
    const terminal = await host.app.terminal.open(project, { command: '/bin/sh' }, { idempotencyKey: 'terminal' })
    assert.throws(() => host.prepareMaintenance(), /终端/)
    await host.app.terminal.close(terminal, { idempotencyKey: 'close' })
    host.prepareMaintenance()
    await assert.rejects(
      host.rpc({ clientId: 'storage', requestId: 'blocked', method: 'settings:get', args: [] }),
      /退出/,
    )
    await assert.rejects(host.app.projects.register({ cwd: f.directory }, { idempotencyKey: 'blocked' }), /退出/)
  } finally {
    await host.dispose()
    await f.dispose()
  }
})
