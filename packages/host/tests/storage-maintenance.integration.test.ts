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
import { readJson, writeJson, optionalStat } from '../src/storage/files'
import { workspaceKey } from '@pi-meme/pi-runtime/runtime-paths'
import { ResourceStore } from '@pi-meme/resources/server/resource-store'
import { runGit } from '@pi-meme/git/server/git-service'
import {
  assertStorageLayout,
  checkStorageLayout,
  initEmptyStorageLayout,
  upgradeStorageLayout,
} from '../src/storage/upgrade'
import { ensureHostIdentity, assertStorageHostIdentity } from '../src/storage/host-identity'
import { attachmentReferencesHeading } from '@pi-meme/contracts/chat-attachments'
import { STORAGE_LAYOUT_VERSION, STORAGE_LAYOUT_FORMAT } from '@pi-meme/contracts/storage-paths'

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
    await mkdir(path.join(f.source, 'cache/session-history'), { recursive: true })
    await writeFile(path.join(f.source, 'cache/session-history/derived.json'), '可重建索引')
    await writeFile(path.join(f.anchor, 'GPUCache/data'), 'cache')
    await writeFile(path.join(f.anchor, 'storage-location.json'), 'keep')
    assert.ok((await cacheSize(f.source, f.anchor)) > 0)
    await clearCaches(f.source, f.anchor)
    assert.equal(await cacheSize(f.source, f.anchor), 0)
    assert.equal(await optionalStat(path.join(f.source, 'cache/session-history')), null)
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
      await assert.rejects(migration(f), /已有服务/)
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
    assert.equal(skill.sourcePath, path.join(f.target, 'resources/skills/example/SKILL.md'))
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
    for (const folder of ['resources/skills/loose', 'resources/builtin/skills/builtin']) {
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
    // 启动时的资源扫描结束后，维护检查才会报告活动终端。
    await vi.waitFor(() => assert.throws(() => host.prepareMaintenance(), /终端/), { timeout: 10000 })
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

test('迁移支持 plugins/installed.json 的版本化 envelope 格式并保留高水位与授权', async () => {
  const f = await fixture()
  try {
    const pluginDir = path.join(f.source, 'plugins', 'directory-example')
    await mkdir(pluginDir, { recursive: true })
    const installedFile = path.join(f.source, 'plugins', 'installed.json')
    const envelope = {
      format: 'pi-meme-plugins',
      version: 1,
      generationHighWaterMark: 7,
      records: [
        {
          id: 'example-plugin',
          directory: pluginDir,
          enabled: true,
          grant: { capabilities: ['ui'] },
          customField: 'preserved',
        },
      ],
    }
    await writeJson(installedFile, envelope)
    await migration(f)
    const migrated = await readJson<typeof envelope>(path.join(f.target, 'plugins', 'installed.json'))
    assert.ok(migrated)
    assert.equal(migrated.format, 'pi-meme-plugins')
    assert.equal(migrated.version, 1)
    assert.equal(migrated.generationHighWaterMark, 7)
    assert.equal(migrated.records[0].id, 'example-plugin')
    assert.equal(migrated.records[0].directory, path.join(f.target, 'plugins', 'directory-example'))
    assert.deepEqual(migrated.records[0].grant, { capabilities: ['ui'] })
    assert.equal(migrated.records[0].customField, 'preserved')
  } finally {
    await f.dispose()
  }
})

test('assertStorageLayout 对空目录直接初始化当前版本清单', async () => {
  const f = await fixture()
  try {
    const emptyDir = path.join(f.directory, 'empty-root')
    await mkdir(emptyDir)
    assert.deepEqual(await checkStorageLayout(emptyDir), { status: 'empty' })
    await assertStorageLayout(emptyDir)
    const manifest = await readJson<{ format: string; version: number }>(path.join(emptyDir, 'storage.json'))
    assert.ok(manifest)
    assert.equal(manifest.format, STORAGE_LAYOUT_FORMAT)
    assert.equal(manifest.version, STORAGE_LAYOUT_VERSION)
    assert.deepEqual(await checkStorageLayout(emptyDir), { status: 'current', version: STORAGE_LAYOUT_VERSION })
  } finally {
    await f.dispose()
  }
})

test('assertStorageLayout 对旧版数据根执行完整就地升级、备份历史、迁移附件与重算哈希', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'old-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'upgrade-fixture')

    // 1. 旧配置与凭据
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark', pinnedPaths: [] })
    await writeFile(path.join(root, 'auth.json'), '{"token":"secret"}', { mode: 0o600 })
    await mkdir(path.join(root, 'pi'))
    await writeJson(path.join(root, 'pi', 'settings.json'), { defaultModel: 'gpt-6-astra' })
    await writeFile(path.join(root, 'pi', 'mcp.log'), 'mcp-log-content')

    // 2. 旧工作区与附件
    const standaloneOld = path.join(root, 'standalone-workspaces', 'test-standalone')
    await mkdir(standaloneOld, { recursive: true })
    const oldCwdHash = workspaceKey(standaloneOld)

    await mkdir(path.join(root, 'workspaces', oldCwdHash), { recursive: true })
    await writeJson(path.join(root, 'workspaces', oldCwdHash, 'mcp-overrides.json'), { enabled: true })

    const attachDir = path.join(root, 'attachments', 'upload-1')
    await mkdir(attachDir, { recursive: true })
    const attachFile = path.join(attachDir, 'photo.png')
    await writeFile(attachFile, 'image-data')

    // 3. 旧会话（包含附件引用文本）
    const oldSessionDir = path.join(root, 'sessions', oldCwdHash)
    await mkdir(oldSessionDir, { recursive: true })
    const oldSessionFile = path.join(oldSessionDir, 'session-1.jsonl')
    const attachmentText = `帮我看这张图\n\n${attachmentReferencesHeading}\n- "photo.png"：${JSON.stringify(attachFile)}`
    const sessionLines = [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: standaloneOld, parentSession: oldSessionFile }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: attachmentText } }),
    ]
    await writeFile(oldSessionFile, `${sessionLines.join('\n')}\n`)

    // 4. 旧状态文件
    await writeJson(path.join(root, 'projects.json'), {
      version: 1,
      projects: [{ cwd: standaloneOld, name: 'Standalone Project' }],
      worktrees: [],
    })
    await writeJson(path.join(root, 'agent-permissions.json'), { [oldSessionFile]: 'workspace-write' })
    await writeJson(path.join(root, 'control.json'), {
      version: 2,
      journalEpoch: 'epoch-1',
      seq: 10,
      projects: [{ cwd: standaloneOld }],
      sessions: [{ sessionId: 'session-1', cwd: standaloneOld, sessionFile: oldSessionFile }],
      operations: {},
      receipts: [],
      events: [],
    })
    await writeJson(path.join(root, 'collaboration.json'), {
      records: [
        {
          summary: {
            agentId: 'agent-1',
            rootAgentId: 'agent-1',
            cwd: standaloneOld,
            sessionFile: oldSessionFile,
            depth: 0,
            status: 'completed',
          },
          mailbox: [],
          consumed: [],
          queued: [],
          interactions: [],
          sequence: 1,
        },
      ],
      plans: [],
    })

    // 5. 旧插件与遗留目录
    const pluginPkg = path.join(root, 'plugins', 'directory-test-plugin')
    await mkdir(pluginPkg, { recursive: true })
    await writeJson(path.join(root, 'plugins', 'installed.json'), {
      format: 'pi-meme-plugins',
      version: 1,
      generationHighWaterMark: 3,
      records: [{ id: 'test-plugin', directory: pluginPkg, enabled: true }],
    })
    const legacyDir = path.join(root, 'validation-sources')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, 'old.txt'), 'legacy-content')

    // 检查布局：应为 needs-upgrade
    assert.deepEqual(await checkStorageLayout(root), { status: 'needs-upgrade', fromVersion: 1 })

    // 执行就地升级
    await assertStorageLayout(root)

    // 验证：
    // 1. storage.json 创建
    const manifest = await readJson<{ format: string; version: number }>(path.join(root, 'storage.json'))
    assert.ok(manifest)
    assert.equal(manifest.version, STORAGE_LAYOUT_VERSION)

    // 2. config/ 迁移
    assert.ok(await readJson(path.join(root, 'config', 'app.json')))
    assert.ok(await readJson(path.join(root, 'config', 'agent', 'settings.json')))
    assert.equal(await readFile(path.join(root, 'logs', 'mcp.log'), 'utf8'), 'mcp-log-content')

    // 3. credentials/ 迁移
    assert.ok(await readFile(path.join(root, 'credentials', 'auth.json'), 'utf8'))

    // 4. state/ 迁移
    assert.ok(await readJson(path.join(root, 'state', 'projects.json')))
    assert.ok(await readJson(path.join(root, 'state', 'plugins.json')))
    assert.ok(await readJson(path.join(root, 'state', 'control', 'snapshot.json')))
    assert.ok(await readJson(path.join(root, 'state', 'collaboration', 'roots', 'agent-1.json')))

    // 5. workspaces/standalone 迁移与重算哈希
    const standaloneNew = path.join(root, 'workspaces', 'standalone', 'test-standalone')
    assert.ok(await optionalStat(standaloneNew))
    const newCwdHash = workspaceKey(standaloneNew)

    // 旧 workspaces/<hash> 应已移到 config/workspaces/<newHash>
    assert.ok(await optionalStat(path.join(root, 'config', 'workspaces', newCwdHash, 'mcp-overrides.json')))

    // sessions 应移到 data/sessions/<newHash>
    const newSessionFile = path.join(root, 'data', 'sessions', newCwdHash, 'session-1.jsonl')
    assert.ok(await optionalStat(newSessionFile))

    // 检查 session 内容重写：
    const updatedLines = (await readFile(newSessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(updatedLines[0].cwd, standaloneNew)
    assert.equal(updatedLines[0].parentSession, newSessionFile)
    const expectedAttachPath = path.join(root, 'data', 'attachments', 'upload-1', 'photo.png')
    assert.ok(updatedLines[1].message.content.includes(expectedAttachPath))

    // 权限文件应更新为 newSessionFile
    const perms = (await readJson<Record<string, string>>(path.join(root, 'state', 'agent-permissions.json')))!
    assert.equal(perms[newSessionFile], 'workspace-write')

    // legacy 目录已移到 backups/legacy
    const legacyReportDir = path.join(root, 'backups')
    assert.ok(await optionalStat(legacyReportDir))

    // 再次调用 assertStorageLayout 幂等通过
    await assertStorageLayout(root)
    assert.deepEqual(await checkStorageLayout(root), { status: 'current', version: STORAGE_LAYOUT_VERSION })
  } finally {
    await f.dispose()
  }
})

test('升级遇到外来未知非空目录拒绝执行并报错', async () => {
  const f = await fixture()
  try {
    const foreignDir = path.join(f.directory, 'foreign-root')
    await mkdir(foreignDir)
    await writeFile(path.join(foreignDir, 'some-random-file.txt'), 'hello')
    const check = await checkStorageLayout(foreignDir)
    assert.equal(check.status, 'corrupt')
    await assert.rejects(assertStorageLayout(foreignDir), /无法识别数据根/)
  } finally {
    await f.dispose()
  }
})

test('升级中途崩溃保留账本和备份，重新调用 assertStorageLayout 可安全续传并完成升级', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'crash-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'crash-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'light' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })
    await writeJson(path.join(root, 'projects.json'), { version: 1, projects: [], worktrees: [] })

    let interrupted = false
    try {
      await upgradeStorageLayout(root, {
        jobId: 'simulated-crash-job',
        progress: (stage) => {
          if (stage === 'transforming') {
            interrupted = true
            throw new Error('模拟突然断电崩溃')
          }
        },
      })
    } catch {
      assert.ok(interrupted)
    }

    // 检查布局：应检测到进行中的任务
    const check = await checkStorageLayout(root)
    assert.equal(check.status, 'in-progress')
    assert.equal(check.jobId, 'simulated-crash-job')

    // 重新调用 assertStorageLayout，应自动恢复续传并完成提交
    await assertStorageLayout(root)

    // 最终布局应已提交且清单完整
    assert.deepEqual(await checkStorageLayout(root), { status: 'current', version: STORAGE_LAYOUT_VERSION })
    const manifest = await readJson<{ format: string; version: number }>(path.join(root, 'storage.json'))
    assert.ok(manifest)
    assert.equal(manifest.version, STORAGE_LAYOUT_VERSION)

    // 配置与凭据完整
    assert.ok(await readJson(path.join(root, 'config', 'app.json')))
    assert.ok(await readFile(path.join(root, 'credentials', 'auth.json'), 'utf8'))
    assert.ok(await readJson(path.join(root, 'state', 'projects.json')))
  } finally {
    await f.dispose()
  }
})

test('升级在发布中途中断（Worktree修复前）崩溃，重入续传成功完成并修复Worktree', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'crash-worktree-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'crash-wt-fixture')

    // 建立真实 git repo 与 worktree
    const repo = path.join(f.directory, 'git-repo')
    await mkdir(repo)
    await runGit(repo, ['init', '--quiet'])
    await runGit(repo, [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ])

    const oldWt = path.join(root, 'worktrees', 'wt-1')
    await mkdir(path.dirname(oldWt), { recursive: true })
    await runGit(repo, ['worktree', 'add', '--detach', oldWt, 'HEAD'])
    await writeFile(path.join(oldWt, 'file.txt'), 'wt-content')

    const oldWtHash = workspaceKey(oldWt)
    const oldSessionDir = path.join(root, 'sessions', oldWtHash)
    await mkdir(oldSessionDir, { recursive: true })
    await writeFile(
      path.join(oldSessionDir, 'session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 's1', cwd: oldWt })}\n`,
    )

    await writeJson(path.join(root, 'projects.json'), {
      version: 1,
      projects: [],
      worktrees: [
        {
          checkoutRoot: oldWt,
          sourceProjectCwd: repo,
          cwd: oldWt,
          baseRef: 'HEAD',
          headSha: 'fixture',
        },
      ],
    })
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"secret"}', { mode: 0o600 })

    let crashOccurred = false
    try {
      await upgradeStorageLayout(root, {
        jobId: 'crash-wt-job',
        progress: (stage) => {
          if (stage === 'publishing') {
            crashOccurred = true
            throw new Error('在 publishing 阶段模拟断电崩溃')
          }
        },
      })
    } catch {
      assert.ok(crashOccurred)
    }

    // 此时应为进行中任务
    const checkBefore = await checkStorageLayout(root)
    assert.equal(checkBefore.status, 'in-progress')
    assert.equal(checkBefore.jobId, 'crash-wt-job')

    // 调用 assertStorageLayout 恢复并完成升级
    await assertStorageLayout(root)

    // 检查布局状态
    assert.deepEqual(await checkStorageLayout(root), { status: 'current', version: STORAGE_LAYOUT_VERSION })

    // 检查 Worktree 已正确重定位并修复
    const newWt = path.join(root, 'workspaces', 'worktrees', 'wt-1')
    assert.ok(await optionalStat(newWt))
    assert.equal(await readFile(path.join(newWt, 'file.txt'), 'utf8'), 'wt-content')
    const wtList = (await runGit(repo, ['worktree', 'list', '--porcelain'])).stdout
    assert.ok(wtList.includes(`worktree ${newWt}`))

    // 检查会话已被重算哈希并重写 cwd
    const newWtHash = workspaceKey(newWt)
    const newSessionFile = path.join(root, 'data', 'sessions', newWtHash, 'session.jsonl')
    assert.ok(await optionalStat(newSessionFile))
    const lines = (await readFile(newSessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].cwd, newWt)

    // 检查维护账本归档于 state/maintenance/
    const archivedReport = path.join(root, 'state', 'maintenance', 'layout-upgrade-crash-wt-job.json')
    assert.ok(await optionalStat(archivedReport))
  } finally {
    await f.dispose()
  }
})

test('assertStorageLayout 遇到损坏的 plugins/installed.json 时明确报错中止，原文件未丢且未提交 storage.json', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'corrupt-plugin-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'corrupt-plugin-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })
    await mkdir(path.join(root, 'plugins'), { recursive: true })
    await writeFile(path.join(root, 'plugins', 'installed.json'), '{invalid json')

    await assert.rejects(assertStorageLayout(root), /插件清单/)

    // 未提交 storage.json
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
    // 原文件保留，未被删除或清空
    assert.equal(await readFile(path.join(root, 'plugins', 'installed.json'), 'utf8'), '{invalid json')
    // 数据根状态非 current
    assert.notEqual((await checkStorageLayout(root)).status, 'current')
  } finally {
    await f.dispose()
  }
})

test('升级完整保留 pi/subagents/custom.md、pi/.hidden 及 pi/extensions/', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'pi-preservation-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'pi-preservation-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 创建 pi/ 目录内容
    const piDir = path.join(root, 'pi')
    await mkdir(path.join(piDir, 'subagents'), { recursive: true })
    await writeFile(path.join(piDir, 'subagents', 'custom.md'), '# 自定义子代理')
    await writeFile(path.join(piDir, '.hidden'), 'hidden-config-value')
    await mkdir(path.join(piDir, 'extensions'), { recursive: true })
    await writeFile(path.join(piDir, 'extensions', 'entry.js'), 'console.log("extension")')
    await writeFile(path.join(piDir, 'settings.json'), '{"model":"test"}')

    await assertStorageLayout(root)

    // 1. subagents/custom.md 与 .hidden 保留在 config/agent/ 中
    assert.equal(await readFile(path.join(root, 'config', 'agent', 'subagents', 'custom.md'), 'utf8'), '# 自定义子代理')
    assert.equal(await readFile(path.join(root, 'config', 'agent', '.hidden'), 'utf8'), 'hidden-config-value')

    // 2. pi/extensions 归档在 backups/legacy/<jobId>/ 中
    const backupsDir = path.join(root, 'backups', 'legacy')
    const legacyEntries = await readdir(backupsDir)
    assert.ok(legacyEntries.length > 0)
    const archivedExt = path.join(backupsDir, legacyEntries[0], 'extensions', 'entry.js')
    assert.equal(await readFile(archivedExt, 'utf8'), 'console.log("extension")')
  } finally {
    await f.dispose()
  }
})

test('root 已存在 config/app.json 且内容冲突时，升级报错且两份均不覆盖', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'conflict-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'conflict-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'old-theme' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 已存在冲突的 config/app.json
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeJson(path.join(root, 'config', 'app.json'), { themeId: 'conflicting-theme' })

    // 升级必须拒绝执行并报错
    await assert.rejects(assertStorageLayout(root), /发布冲突|目标文件已存在/)

    // 两份文件内容原样保留，未被覆盖
    assert.equal((await readJson<{ themeId: string }>(path.join(root, 'settings.json')))?.themeId, 'old-theme')
    assert.equal(
      (await readJson<{ themeId: string }>(path.join(root, 'config', 'app.json')))?.themeId,
      'conflicting-theme',
    )
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
  } finally {
    await f.dispose()
  }
})

test('账本 stagingDir/backupDir 被篡改或指向 root 时拒绝恢复，防止误删根目录', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'tampered-ledger-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'tampered-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 构造篡改账本：stagingDir 指向 root
    const tamperedLedger = {
      version: 1,
      id: 'malicious-job',
      hostId: 'tampered-fixture',
      stage: 'staged',
      backupDir: path.join(root, 'backups', 'layout-malicious-job'),
      stagingDir: root, // 篡改为 root
      legacyDir: path.join(root, 'backups', 'legacy-malicious-job'),
      worktrees: [],
      publishItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeJson(path.join(root, '.storage-layout-upgrade-malicious-job.json'), tamperedLedger)

    // 恢复升级必须拒绝并报错
    await assert.rejects(assertStorageLayout(root), /目录不合法|被篡改|不能为数据根/)

    // 根目录下原文件完好无损，未被误删
    assert.ok(await readFile(path.join(root, 'auth.json'), 'utf8'))
  } finally {
    await f.dispose()
  }
})

test('requests、附件、计划、profile 及未知子文件均在备份中完整保留，不盲目递归删除', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'full-backup-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'full-backup-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // requests
    await mkdir(path.join(root, 'requests'), { recursive: true })
    const reqHash = 'a'.repeat(64)
    const inputHash = 'b'.repeat(64)
    await writeFile(path.join(root, 'requests', reqHash), inputHash)

    // attachments
    await mkdir(path.join(root, 'attachments', 'u1'), { recursive: true })
    await writeFile(path.join(root, 'attachments', 'u1', 'att.bin'), 'attachment-binary-data')

    // plans
    await mkdir(path.join(root, 'plans', 's1'), { recursive: true })
    await writeFile(path.join(root, 'plans', 's1', 'plan1.md'), '# 计划正文')

    // profile
    await mkdir(path.join(root, 'profile'), { recursive: true })
    await writeJson(path.join(root, 'profile', 'profile.json'), { name: 'Alice' })
    await writeFile(path.join(root, 'profile', 'avatar.png'), 'avatar-binary')

    // 未知文件/子目录
    await mkdir(path.join(root, 'profile', 'custom-sub'), { recursive: true })
    await writeFile(path.join(root, 'profile', 'custom-sub', 'notes.txt'), 'custom-profile-note')

    await assertStorageLayout(root)

    // 验证备份目录中完整包含所有这些文件
    const backupsDir = path.join(root, 'backups', 'layout')
    const layoutEntries = await readdir(backupsDir)
    assert.ok(layoutEntries.length > 0)
    const backupRoot = path.join(backupsDir, layoutEntries[0])

    assert.equal(await readFile(path.join(backupRoot, 'requests', reqHash), 'utf8'), inputHash)
    assert.equal(
      await readFile(path.join(backupRoot, 'attachments', 'u1', 'att.bin'), 'utf8'),
      'attachment-binary-data',
    )
    assert.equal(await readFile(path.join(backupRoot, 'plans', 's1', 'plan1.md'), 'utf8'), '# 计划正文')
    assert.equal(await readFile(path.join(backupRoot, 'profile', 'avatar.png'), 'utf8'), 'avatar-binary')
    assert.equal(
      await readFile(path.join(backupRoot, 'profile', 'custom-sub', 'notes.txt'), 'utf8'),
      'custom-profile-note',
    )

    // 验证升级后目标位置存在对应文件
    assert.ok(await optionalStat(path.join(root, 'state', 'requests.jsonl')))
    assert.equal(
      await readFile(path.join(root, 'data', 'attachments', 'u1', 'att.bin'), 'utf8'),
      'attachment-binary-data',
    )
    assert.equal(await readFile(path.join(root, 'data', 'plans', 's1', 'plan1.md'), 'utf8'), '# 计划正文')
    assert.equal(await readFile(path.join(root, 'config', 'profile', 'avatar.png'), 'utf8'), 'avatar-binary')
    assert.equal(
      await readFile(path.join(root, 'config', 'profile', 'custom-sub', 'notes.txt'), 'utf8'),
      'custom-profile-note',
    )
  } finally {
    await f.dispose()
  }
})

test('升级恢复在 stagingDir 为 symlink 或 jobId 非法时严密拒绝', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'symlink-guard-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'symlink-guard-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 1. 非法 jobId
    const badJobLedger = {
      version: 1,
      id: 'bad$job',
      hostId: 'symlink-guard-fixture',
      stage: 'staged',
      backupDir: path.join(root, 'backups', 'layout', 'bad$job'),
      stagingDir: path.join(root, '.upgrade-staging-bad$job'),
      legacyDir: path.join(root, 'backups', 'legacy', 'bad$job'),
      worktrees: [],
      publishItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeJson(path.join(root, '.storage-layout-upgrade-bad$job.json'), badJobLedger)
    await assert.rejects(assertStorageLayout(root), /非法的布局升级任务 ID/)
    await rm(path.join(root, '.storage-layout-upgrade-bad$job.json'))

    // 2. stagingDir 为符号链接
    const symlinkJobId = 'symlink-job-test'
    const externalTarget = path.join(f.directory, 'external-dir')
    await mkdir(externalTarget)
    const stagedSymlink = path.join(root, `.upgrade-staging-${symlinkJobId}`)
    const { symlink } = await import('node:fs/promises')
    await symlink(externalTarget, stagedSymlink)

    const symlinkLedger = {
      version: 1,
      id: symlinkJobId,
      hostId: 'symlink-guard-fixture',
      stage: 'staged',
      backupDir: path.join(root, 'backups', 'layout', symlinkJobId),
      stagingDir: stagedSymlink,
      legacyDir: path.join(root, 'backups', 'legacy', symlinkJobId),
      worktrees: [],
      publishItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeJson(path.join(root, `.storage-layout-upgrade-${symlinkJobId}.json`), symlinkLedger)
    await assert.rejects(assertStorageLayout(root), /符号链接/)
  } finally {
    await f.dispose()
  }
})

test('发布阶段遇到目标路径为目录或非常规文件时判定为冲突并中止', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'conflict-dir-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'conflict-dir-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 在本应作为文件的 config/app.json 处预先创建一个目录
    await mkdir(path.join(root, 'config', 'app.json'), { recursive: true })

    await assert.rejects(assertStorageLayout(root), /发布冲突：目标路径已存在非常规文件或目录/)
  } finally {
    await f.dispose()
  }
})

test('就地升级完整重写 control events/operations 及多模态多段附件引用与工作区技能所有者', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'full-rewrite-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'full-rewrite-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    const standaloneOld = path.join(root, 'standalone-workspaces', 'ws1')
    await mkdir(standaloneOld, { recursive: true })
    const oldHash = workspaceKey(standaloneOld)

    // control.json 包含 standalone 路径的项目与会话
    const oldControl = {
      version: 2,
      journalEpoch: 'epoch-1',
      seq: 1,
      projects: [{ id: 'p1', cwd: standaloneOld, name: 'proj' }],
      sessions: [
        {
          hostId: 'full-rewrite-fixture',
          sessionId: 's1',
          cwd: standaloneOld,
          sessionFile: path.join(root, 'sessions', oldHash, 's1.jsonl'),
          status: 'idle',
          createdAt: new Date().toISOString(),
        },
      ],
      operations: {},
      receipts: [],
      events: [
        { commitSeq: 1, timestamp: new Date().toISOString(), type: 'project-upsert', value: { cwd: standaloneOld } },
      ],
    }
    await writeJson(path.join(root, 'control.json'), oldControl)

    // sessions 包含多模态多段数组附件
    const sessionDir = path.join(root, 'sessions', oldHash)
    await mkdir(sessionDir, { recursive: true })
    const sessionLines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: standaloneOld }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `这是附件说明\n\n${attachmentReferencesHeading}\n- "att1"：${JSON.stringify(path.join(root, 'attachments', 'u1', 'att.bin'))}`,
            },
          ],
        },
      }),
    ]
    await writeFile(path.join(sessionDir, 's1.jsonl'), `${sessionLines.join('\n')}\n`)

    // resources 包含工作区技能
    await mkdir(path.join(root, 'resources'), { recursive: true })
    const resState = {
      generation: 1,
      ownerIds: {
        'standalone-workspaces/ws1': 1,
        'skills/custom': 1,
      },
      imports: [],
    }
    await writeJson(path.join(root, 'resources', 'state.json'), resState)

    await assertStorageLayout(root)

    // 1. 验证 control events.jsonl 重写
    const eventsContent = await readFile(path.join(root, 'state', 'control', 'events.jsonl'), 'utf8')
    assert.ok(!eventsContent.includes('standalone-workspaces/ws1'))
    assert.ok(eventsContent.includes('workspaces/standalone/ws1'))

    // 2. 验证多模态 session 附件重写
    const newHash = workspaceKey(path.join(root, 'workspaces', 'standalone', 'ws1'))
    const newSessionContent = await readFile(path.join(root, 'data', 'sessions', newHash, 's1.jsonl'), 'utf8')
    assert.ok(newSessionContent.includes(path.join(root, 'data', 'attachments', 'u1', 'att.bin')))
    assert.ok(!newSessionContent.includes(path.join(root, 'attachments', 'u1', 'att.bin')))

    // 3. 验证 resources ownerIds 重写
    const updatedRes = await readJson<{ ownerIds: Record<string, number> }>(path.join(root, 'state', 'resources.json'))
    assert.ok(updatedRes?.ownerIds['workspaces/standalone/ws1'])
    assert.equal(updatedRes?.ownerIds['standalone-workspaces/ws1'], undefined)
  } finally {
    await f.dispose()
  }
})

test('升级完整迁移旧 plugin-data 私有数据至 plugins/data 与 state/modules 并归档原件', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'plugin-data-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'plugin-data-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 创建旧 plugin-data: 外部插件与内置模块
    await mkdir(path.join(root, 'plugin-data', 'external-plugin-id'), { recursive: true })
    await writeJson(path.join(root, 'plugin-data', 'external-plugin-id', 'state.json'), { count: 42 })

    await mkdir(path.join(root, 'plugin-data', '@pi-meme%2Fchat'), { recursive: true })
    await writeJson(path.join(root, 'plugin-data', '@pi-meme%2Fchat', 'config.json'), { enabled: true })

    await assertStorageLayout(root)

    // 1. 外部插件数据迁移至 plugins/data/<id>/
    const extData = await readJson<{ count: number }>(
      path.join(root, 'plugins', 'data', 'external-plugin-id', 'state.json'),
    )
    assert.equal(extData?.count, 42)

    // 2. 内置模块数据迁移至 state/modules/<id>/
    const coreData = await readJson<{ enabled: boolean }>(
      path.join(root, 'state', 'modules', '@pi-meme%2Fchat', 'config.json'),
    )
    assert.equal(coreData?.enabled, true)

    // 3. 原 plugin-data 已从 root 移除
    assert.equal(await optionalStat(path.join(root, 'plugin-data')), null)

    // 4. 备份中完整保留
    const backupsDir = path.join(root, 'backups', 'layout')
    const layoutEntries = await readdir(backupsDir)
    assert.ok(layoutEntries.length > 0)
    const backupRoot = path.join(backupsDir, layoutEntries[0])
    const backedUpData = await readJson<{ count: number }>(
      path.join(backupRoot, 'plugin-data', 'external-plugin-id', 'state.json'),
    )
    assert.equal(backedUpData?.count, 42)
  } finally {
    await f.dispose()
  }
})

test('目标父目录或备份目录为 symlink 时拒绝升级，外部 sentinel 保持不变', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'symlink-parent-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'symlink-parent-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 1. root/config -> 外部目录
    const externalConfig = path.join(f.directory, 'external-config')
    await mkdir(externalConfig)
    await writeFile(path.join(externalConfig, 'sentinel.txt'), 'keep-external-config')
    await symlink(externalConfig, path.join(root, 'config'))

    await assert.rejects(assertStorageLayout(root), /不允许路径链接/)

    // 外部 sentinel 完好，且未被写入 app.json
    assert.equal(await readFile(path.join(externalConfig, 'sentinel.txt'), 'utf8'), 'keep-external-config')
    assert.equal(await optionalStat(path.join(externalConfig, 'app.json')), null)

    // 清除测试 1 的 symlink 与临时残余
    await rm(path.join(root, 'config'))
    await rm(path.join(root, 'backups'), { recursive: true, force: true })

    // 2. root/backups -> 外部目录
    const externalBackups = path.join(f.directory, 'external-backups')
    await mkdir(externalBackups)
    await writeFile(path.join(externalBackups, 'sentinel.txt'), 'keep-external-backups')
    await symlink(externalBackups, path.join(root, 'backups'))

    await assert.rejects(assertStorageLayout(root), /不允许路径链接/)

    // 外部备份 sentinel 完好
    assert.equal(await readFile(path.join(externalBackups, 'sentinel.txt'), 'utf8'), 'keep-external-backups')
  } finally {
    await f.dispose()
  }
})

test('旧 standalone/<id>/old.txt 与新 workspaces/standalone/<id>/other.txt 同时存在时拒绝发布并保留两份', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'dir-conflict-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'dir-conflict-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 旧 standalone-workspaces/ws1 存在 old.txt
    const oldDir = path.join(root, 'standalone-workspaces', 'ws1')
    await mkdir(oldDir, { recursive: true })
    await writeFile(path.join(oldDir, 'old.txt'), 'original-old-content')

    // 新 workspaces/standalone/ws1 已经存在 other.txt
    const conflictDir = path.join(root, 'workspaces', 'standalone', 'ws1')
    await mkdir(conflictDir, { recursive: true })
    await writeFile(path.join(conflictDir, 'other.txt'), 'conflicting-other-content')

    // 升级必须中止
    await assert.rejects(assertStorageLayout(root), /发布冲突：目标目录已存在/)

    // 两份内容全部完整保留
    assert.equal(await readFile(path.join(oldDir, 'old.txt'), 'utf8'), 'original-old-content')
    assert.equal(await readFile(path.join(conflictDir, 'other.txt'), 'utf8'), 'conflicting-other-content')

    // storage.json 未提交
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
  } finally {
    await f.dispose()
  }
})

test('升级保留普通 loose 技能与 builtin 技能的 ResourceStore 身份与 policy 映射', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'resource-identity-root')
    await mkdir(root)
    const hostId = 'resource-identity-fixture'
    await writeFile(path.join(root, 'host-id'), hostId)
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 1. 创建旧版 loose 技能（位于旧 root/skills/my-loose-skill）
    const skillDir = path.join(root, 'skills', 'my-loose-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: my-loose-skill\ndescription: Loose skill test\n---\n# Loose Skill\n`,
    )

    // 2. 计算在旧版 v1 下 loose 技能的 ownerId 与 resource ID
    const { resourceIdentity } = await import('@pi-meme/resources/server/resource-identity')
    const oldOwnerId = resourceIdentity(skillDir)
    const oldSkillId = resourceIdentity(`${hostId}:host:${oldOwnerId}:skill:SKILL.md`)

    // 3. 在旧版 resources/state.json 中记录手动 policy（无显式 ownerIds，测试升级自动补充映射）
    await mkdir(path.join(root, 'resources'), { recursive: true })
    const oldResState = {
      generation: 1,
      ownerIds: {},
      policies: {
        [`host:${oldSkillId}`]: { enabled: false, invocation: 'manual' },
      },
      imports: [],
    }
    await writeJson(path.join(root, 'resources', 'state.json'), oldResState)

    // 4. 执行存储布局升级
    await assertStorageLayout(root)

    // 5. 在升级后的 v2 目录中使用官方 ResourceStore 实例加载
    const store = new ResourceStore(root, { hostId })
    await store.init()
    const catalog = await store.catalog()
    const loose = catalog.items.find((i) => i.name === 'my-loose-skill')
    assert.ok(loose)

    // 核心断言：资源 ID 保持一致，策略保持生效（enabled 依然为 false）
    assert.equal(loose.id, oldSkillId)
    assert.equal(loose.enabled, false)
  } finally {
    await f.dispose()
  }
})

test('plugin-data 包含单文件而非目录时不崩溃并正常迁移', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'plugin-data-file-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'plugin-data-file-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    await mkdir(path.join(root, 'plugin-data'), { recursive: true })
    await writeFile(path.join(root, 'plugin-data', 'loose-file.txt'), 'loose-plugin-data-content')

    await assertStorageLayout(root)

    assert.equal(
      await readFile(path.join(root, 'plugins', 'data', 'loose-file.txt'), 'utf8'),
      'loose-plugin-data-content',
    )
  } finally {
    await f.dispose()
  }
})

test('旧根完全缺失 resources/state.json 时依然保留 loose 技能 ID', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'missing-res-state-root')
    await mkdir(root)
    const hostId = 'missing-res-fixture'
    await writeFile(path.join(root, 'host-id'), hostId)
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 创建旧版 loose 技能，但故意不创建 resources/state.json
    const skillDir = path.join(root, 'skills', 'standalone-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: standalone-skill\ndescription: Standalone test\n---\n# Standalone Skill\n`,
    )

    const { resourceIdentity } = await import('@pi-meme/resources/server/resource-identity')
    const oldOwnerId = resourceIdentity(skillDir)
    const expectedSkillId = resourceIdentity(`${hostId}:host:${oldOwnerId}:skill:SKILL.md`)

    await assertStorageLayout(root)

    // 升级后必须生成 state/resources.json 并记录 ownerIds 映射
    const resDoc = await readJson<{ ownerIds: Record<string, string> }>(path.join(root, 'state', 'resources.json'))
    assert.ok(resDoc?.ownerIds['resources/skills/standalone-skill'])
    assert.equal(resDoc?.ownerIds['resources/skills/standalone-skill'], oldOwnerId)

    // 使用官方 ResourceStore 验证 ID 完全稳定
    const store = new ResourceStore(root, { hostId })
    await store.init()
    const catalog = await store.catalog()
    const found = catalog.items.find((i) => i.name === 'standalone-skill')
    assert.ok(found)
    assert.equal(found.id, expectedSkillId)
  } finally {
    await f.dispose()
  }
})

test('升级在 publishing 阶段数据源发生修改时中止恢复，保护最新修改', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'source-mutation-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'source-mutation-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'original-theme' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    const jobId = 'simulated-mutation-job'
    // 首次升级：在到达 publishing 阶段时模拟外部并发修改源文件并发生崩溃
    await assert.rejects(
      upgradeStorageLayout(root, {
        jobId,
        progress: (stage) => {
          if (stage === 'publishing') {
            writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ themeId: 'modified-by-user' }))
            throw new Error('simulated-crash-at-publishing')
          }
        },
      }),
      /simulated-crash-at-publishing/,
    )

    // 恢复升级：必须识别到源文件在升级期间被修改，拒绝继续以防止用旧数据覆盖用户修改
    const { resumeStorageLayoutUpgrade } = await import('../src/storage/upgrade')
    await assert.rejects(resumeStorageLayoutUpgrade(root, jobId), /检测到数据源文件在升级期间被修改/)

    // 验证用户在升级期间做出的修改依然完整保留
    const currentSettings = await readJson<{ themeId: string }>(path.join(root, 'settings.json'))
    assert.equal(currentSettings?.themeId, 'modified-by-user')

    // storage.json 未提交
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
  } finally {
    await f.dispose()
  }
})

test('目录搬迁后目标被外部篡改替换时，恢复阶段通过指纹拦截', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'dir-tamper-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'dir-tamper-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    const jobId = 'dir-tamper-job'
    // 构造一个处于 publishing 阶段的账本
    const tamperLedger = {
      version: 1,
      id: jobId,
      hostId: 'dir-tamper-fixture',
      stage: 'publishing',
      backupDir: path.join(root, 'backups', 'layout', jobId),
      stagingDir: path.join(root, `.upgrade-staging-${jobId}`),
      legacyDir: path.join(root, 'backups', 'legacy', jobId),
      worktrees: [],
      publishItems: [],
      dirMoves: [
        {
          fromRelative: 'standalone-workspaces/ws1',
          toRelative: 'workspaces/standalone/ws1',
          fingerprint: 'expected-original-sha256-fingerprint',
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await mkdir(tamperLedger.backupDir, { recursive: true })
    await mkdir(tamperLedger.stagingDir, { recursive: true })
    await writeJson(path.join(tamperLedger.backupDir, 'backup-manifest.json'), {})
    await writeJson(path.join(root, `.storage-layout-upgrade-${jobId}.json`), tamperLedger)

    // 源 standalone-workspaces/ws1 已不存在（模拟已移动），但目标 workspaces/standalone/ws1 的指纹被外部替换篡改
    const targetDir = path.join(root, 'workspaces', 'standalone', 'ws1')
    await mkdir(targetDir, { recursive: true })
    await writeFile(path.join(targetDir, 'tampered.txt'), 'tampered-content')

    const { resumeStorageLayoutUpgrade } = await import('../src/storage/upgrade')
    await assert.rejects(resumeStorageLayoutUpgrade(root, jobId), /已存在的目标目录指纹不匹配本次任务/)
  } finally {
    await f.dispose()
  }
})

test('命名空间包含 @pi-meme 的外部插件准确分流至 plugins/data 而非 state/modules', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'scoped-ext-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'scoped-ext-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 构造一个名字以 @pi-meme 命名空间的外部插件（非内置模块）
    const extPluginDir = path.join(root, 'plugin-data', '%40pi-meme%2Fcommunity-tool')
    await mkdir(extPluginDir, { recursive: true })
    await writeJson(path.join(extPluginDir, 'state.json'), { customValue: 'community' })

    await assertStorageLayout(root)

    // 必须分流至 plugins/data/，绝不可进入 state/modules/
    const dataFile = path.join(root, 'plugins', 'data', '%40pi-meme%2Fcommunity-tool', 'state.json')
    const modFile = path.join(root, 'state', 'modules', '%40pi-meme%2Fcommunity-tool', 'state.json')

    assert.ok(await optionalStat(dataFile))
    assert.equal((await readJson<{ customValue: string }>(dataFile))?.customValue, 'community')
    assert.equal(await optionalStat(modFile), null)
  } finally {
    await f.dispose()
  }
})

test('manifest.version 严格校验：0/负数/小数/缺失均被判定为 corrupt 拒绝升级', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'bad-version-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'bad-version-fixture')

    // 1. version: 0
    await writeJson(path.join(root, 'storage.json'), { format: STORAGE_LAYOUT_FORMAT, version: 0 })
    const res0 = await checkStorageLayout(root)
    assert.equal(res0.status, 'corrupt')
    assert.match((res0 as { error: string }).error, /版本无效/)

    // 2. version: -1
    await writeJson(path.join(root, 'storage.json'), { format: STORAGE_LAYOUT_FORMAT, version: -1 })
    const resNeg = await checkStorageLayout(root)
    assert.equal(resNeg.status, 'corrupt')
    assert.match((resNeg as { error: string }).error, /版本无效/)

    // 3. version: 1.5
    await writeJson(path.join(root, 'storage.json'), { format: STORAGE_LAYOUT_FORMAT, version: 1.5 })
    const resFloat = await checkStorageLayout(root)
    assert.equal(resFloat.status, 'corrupt')
    assert.match((resFloat as { error: string }).error, /版本无效/)

    // 4. 缺失 version
    await writeJson(path.join(root, 'storage.json'), { format: STORAGE_LAYOUT_FORMAT })
    const resMissing = await checkStorageLayout(root)
    assert.equal(resMissing.status, 'corrupt')
    assert.match((resMissing as { error: string }).error, /版本无效/)
  } finally {
    await f.dispose()
  }
})

test('升级在 publishing 阶段新增未备份文件（如 profile/new-user.txt）时中止恢复，保护新文件不丢失', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'new-file-mutation-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'new-file-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    await mkdir(path.join(root, 'profile'), { recursive: true })
    await writeJson(path.join(root, 'profile', 'profile.json'), { name: 'Alice' })

    const jobId = 'new-file-mutation-job'
    // 首次升级：在到达 publishing 阶段时模拟并发新增 profile/new-user.txt 并崩溃
    await assert.rejects(
      upgradeStorageLayout(root, {
        jobId,
        progress: (stage) => {
          if (stage === 'publishing') {
            writeFileSync(path.join(root, 'profile', 'new-user.txt'), 'newly-created-profile-note')
            throw new Error('simulated-crash-with-new-file')
          }
        },
      }),
      /simulated-crash-with-new-file/,
    )

    // 恢复升级：必须识别到源目录中新增了未备份的文件，拒绝继续以防止丢失该文件
    const { resumeStorageLayoutUpgrade } = await import('../src/storage/upgrade')
    await assert.rejects(resumeStorageLayoutUpgrade(root, jobId), /新增了未备份文件/)

    // 核心断言：新创建的文件完好无损，未被递归删除
    assert.equal(await readFile(path.join(root, 'profile', 'new-user.txt'), 'utf8'), 'newly-created-profile-note')

    // storage.json 未提交
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
  } finally {
    await f.dispose()
  }
})

test('历史资源快照 resources/snapshots 保持原路径不被 archive 且引用可读，备份也存在', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'snapshot-keep-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'snapshot-keep-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 1. 创建历史资源快照（特定历史 revision，无法仅从当前 skills 重新生成）
    const rev = 'rev-historical-abc123'
    const snapshotSkill = path.join(root, 'resources', 'snapshots', rev, 'SKILL.md')
    await mkdir(path.dirname(snapshotSkill), { recursive: true })
    await writeFile(snapshotSkill, '# 历史技能版本 abc123\nname: old-skill\n')

    // 2. 在会话记录中引用该快照路径
    const projectCwd = path.join(f.directory, 'proj')
    await mkdir(projectCwd, { recursive: true })
    const h = workspaceKey(projectCwd)
    const sessionDir = path.join(root, 'sessions', h)
    await mkdir(sessionDir, { recursive: true })
    const sessionLine = JSON.stringify({
      type: 'custom',
      customType: 'pi-meme.skill-use',
      data: { name: 'old-skill', path: snapshotSkill },
    })
    await writeFile(path.join(sessionDir, 's1.jsonl'), `${sessionLine}\n`)

    await assertStorageLayout(root)

    // 核心断言 1：升级后 resources/snapshots/<rev>/SKILL.md 逐字保留在原路径，未被归档到 originals 移走
    assert.ok(await optionalStat(snapshotSkill))
    assert.equal(await readFile(snapshotSkill, 'utf8'), '# 历史技能版本 abc123\nname: old-skill\n')

    // 核心断言 2：备份中完整保留快照
    const backupsDir = path.join(root, 'backups', 'layout')
    const layoutEntries = await readdir(backupsDir)
    assert.ok(layoutEntries.length > 0)
    const backupSnapshot = path.join(backupsDir, layoutEntries[0], 'resources', 'snapshots', rev, 'SKILL.md')
    assert.equal(await readFile(backupSnapshot, 'utf8'), '# 历史技能版本 abc123\nname: old-skill\n')

    // 核心断言 3：新会话记录依然可以读取该快照文件
    const newSessionFile = path.join(root, 'data', 'sessions', h, 's1.jsonl')
    const content = await readFile(newSessionFile, 'utf8')
    assert.ok(content.includes(snapshotSkill))
    assert.ok(await optionalStat(snapshotSkill))
  } finally {
    await f.dispose()
  }
})

test('账本 stage 非法或未知时明确报错拒绝恢复，不生成 storage.json 且保留原文件', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'invalid-stage-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'invalid-stage-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    const jobId = 'invalid-stage-job'
    const corruptLedger = {
      version: 1,
      id: jobId,
      hostId: 'invalid-stage-fixture',
      stage: 'unknown_stage_value',
      backupDir: path.join(root, 'backups', 'layout', jobId),
      stagingDir: path.join(root, `.upgrade-staging-${jobId}`),
      legacyDir: path.join(root, 'backups', 'legacy', jobId),
      worktrees: [],
      publishItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeJson(path.join(root, `.storage-layout-upgrade-${jobId}.json`), corruptLedger)

    // assertStorageLayout 遇到该任务必须抛错拒绝继续，严禁静默成功放行
    await assert.rejects(assertStorageLayout(root), /stage 状态非法或未知/)

    // 原文件保留，未提交 storage.json
    assert.equal(await readFile(path.join(root, 'auth.json'), 'utf8'), '{"auth":"test"}')
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
  } finally {
    await f.dispose()
  }
})

test('publishing 阶段缺失 backup-manifest.json 时明确报错拒绝恢复，不跳过校验', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'missing-manifest-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'missing-manifest-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    const jobId = 'missing-manifest-job'
    const ledger = {
      version: 1,
      id: jobId,
      hostId: 'missing-manifest-fixture',
      stage: 'publishing',
      backupDir: path.join(root, 'backups', 'layout', jobId),
      stagingDir: path.join(root, `.upgrade-staging-${jobId}`),
      legacyDir: path.join(root, 'backups', 'legacy', jobId),
      worktrees: [],
      publishItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await mkdir(ledger.backupDir, { recursive: true })
    await mkdir(ledger.stagingDir, { recursive: true })
    // 故意不创建 backup-manifest.json
    await writeJson(path.join(root, `.storage-layout-upgrade-${jobId}.json`), ledger)

    const { resumeStorageLayoutUpgrade } = await import('../src/storage/upgrade')
    await assert.rejects(resumeStorageLayoutUpgrade(root, jobId), /备份清单缺失或损坏/)

    // 原文件保留，未提交 storage.json
    assert.equal(await readFile(path.join(root, 'auth.json'), 'utf8'), '{"auth":"test"}')
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)
  } finally {
    await f.dispose()
  }
})

test('backupManifest 包含越界相对路径（如 pi/../../outside.txt）或非法哈希时拒绝恢复，根外文件保持不变', async () => {
  const f = await fixture()
  try {
    const root = path.join(f.directory, 'escape-manifest-root')
    await mkdir(root)
    await writeFile(path.join(root, 'host-id'), 'escape-manifest-fixture')
    await writeJson(path.join(root, 'settings.json'), { themeId: 'dark' })
    await writeFile(path.join(root, 'auth.json'), '{"auth":"test"}', { mode: 0o600 })

    // 在数据根外部创建一个文件
    const outsideFile = path.join(f.directory, 'outside.txt')
    await writeFile(outsideFile, 'outside-secret-content')

    const jobId = 'escape-manifest-job'
    const ledger = {
      version: 1,
      id: jobId,
      hostId: 'escape-manifest-fixture',
      stage: 'publishing',
      backupDir: path.join(root, 'backups', 'layout', jobId),
      stagingDir: path.join(root, `.upgrade-staging-${jobId}`),
      legacyDir: path.join(root, 'backups', 'legacy', jobId),
      worktrees: [],
      publishItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await mkdir(ledger.backupDir, { recursive: true })
    await mkdir(ledger.stagingDir, { recursive: true })
    await writeJson(path.join(root, `.storage-layout-upgrade-${jobId}.json`), ledger)

    // 1. 尝试使用篡改了越界路径的 backup-manifest.json
    const maliciousManifest = {
      'pi/../../outside.txt': 'a'.repeat(64),
    }
    await writeJson(path.join(ledger.backupDir, 'backup-manifest.json'), maliciousManifest)

    const { resumeStorageLayoutUpgrade } = await import('../src/storage/upgrade')
    await assert.rejects(resumeStorageLayoutUpgrade(root, jobId), /存储路径超出数据目录/)

    // 根外文件必须原样保留，未被移动或删除
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside-secret-content')
    assert.equal(await optionalStat(path.join(root, 'storage.json')), null)

    // 2. 尝试使用非法非 64-hex 哈希值
    const badHashManifest = {
      'settings.json': 'invalid-not-64-hex-hash',
    }
    await writeJson(path.join(ledger.backupDir, 'backup-manifest.json'), badHashManifest)
    await assert.rejects(resumeStorageLayoutUpgrade(root, jobId), /非法哈希值/)
  } finally {
    await f.dispose()
  }
})

function identitySnapshot(hostId: string, cwd: string) {
  return {
    version: 2,
    journalEpoch: 'identity-epoch',
    appliedCommitSeq: 0,
    seq: 0,
    projects: [{ hostId, projectId: 'preserved-project', cwd, name: '保留项目' }],
    sessions: [
      {
        hostId,
        sessionId: 'preserved-session',
        project: { hostId, projectId: 'preserved-project' },
        cwd,
        createdAt: '2026-10-24T00:00:00.000Z',
        configuration: {},
        status: 'idle',
      },
    ],
    receipts: [],
  }
}

test.each(['snapshot', 'events', 'operations'])(
  '启动在加载 %s 身份冲突时中止，保留控制状态和会话原文',
  async (kind) => {
    const f = await fixture()
    try {
      await initEmptyStorageLayout(f.source)
      const directory = path.join(f.source, 'state/control')
      await mkdir(directory, { recursive: true })
      const snapshot = identitySnapshot(kind === 'snapshot' ? 'other-host' : 'storage-fixture', f.source)
      await writeJson(path.join(directory, 'snapshot.json'), snapshot)
      if (kind === 'events')
        await writeFile(
          path.join(directory, 'events.jsonl'),
          `${JSON.stringify({
            commitSeq: 1,
            journalEpoch: snapshot.journalEpoch,
            timestamp: '2026-10-24T00:00:00.000Z',
            event: { hostId: 'other-host', type: 'runtime', journalEpoch: snapshot.journalEpoch, seq: 1, value: {} },
          })}\n`,
        )
      if (kind === 'operations')
        await writeFile(
          path.join(directory, 'operations.jsonl'),
          `${JSON.stringify({
            id: '["client","key"]',
            operationId: 'preserved-operation',
            input: 'input-hash',
            status: 'completed',
            result: { receipt: { session: { hostId: 'other-host', sessionId: 'preserved-session' } } },
          })}\n`,
        )
      const sessionFile = path.join(f.source, 'data/sessions/retained.jsonl')
      await mkdir(path.dirname(sessionFile), { recursive: true })
      const message = '{"type":"message","message":{"role":"user","content":"保留完整会话"}}\n'
      await writeFile(sessionFile, message)
      const before = await Promise.all(
        (await readdir(directory)).map(async (name) => [name, await readFile(path.join(directory, name), 'utf8')]),
      )
      await assert.rejects(createHost({ dataRoot: f.source, testCredentials: true }), /服务身份不一致/)
      for (const [name, content] of before) assert.equal(await readFile(path.join(directory, name), 'utf8'), content)
      assert.equal(await readFile(sessionFile, 'utf8'), message)
      assert.equal(await optionalStat(path.join(f.source, 'host.lock')), null)
    } finally {
      await f.dispose()
    }
  },
)

test('Host 启动读取带换行的 host-id 时使用规范身份，保留原有项目与会话引用', async () => {
  const f = await fixture()
  try {
    await initEmptyStorageLayout(f.source)
    await writeFile(path.join(f.source, 'host-id'), 'storage-fixture\n')
    await mkdir(path.join(f.source, 'state/control'), { recursive: true })
    await writeJson(path.join(f.source, 'state/control/snapshot.json'), identitySnapshot('storage-fixture', f.source))
    const host = await createHost({ dataRoot: f.source, testCredentials: true })
    try {
      assert.equal(host.hostId, 'storage-fixture')
      assert.equal((await host.app.sessions.list())[0]?.sessionId, 'preserved-session')
      assert.equal((await host.app.projects.list())[0]?.projectId, 'preserved-project')
      await assertStorageHostIdentity(f.source, host.hostId)
    } finally {
      await host.dispose()
    }
  } finally {
    await f.dispose()
  }
})

test('布局升级缺少 host-id 时恢复唯一历史身份，备份身份文件并保留稳定引用', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.source, 'host-id'))
    const legacy = { ...identitySnapshot('historical-host', f.source), operations: {}, events: [] }
    await writeJson(path.join(f.source, 'control.json'), legacy)
    await upgradeStorageLayout(f.source)
    assert.equal(await readFile(path.join(f.source, 'host-id'), 'utf8'), 'historical-host')
    await assertStorageHostIdentity(f.source, 'historical-host')
    const snapshot = await readJson<typeof legacy>(path.join(f.source, 'state/control/snapshot.json'))
    assert.equal(snapshot?.projects[0].hostId, 'historical-host')
    assert.equal(snapshot?.sessions[0].sessionId, 'preserved-session')
    const jobs = await readdir(path.join(f.source, 'backups/layout'))
    assert.equal(await readFile(path.join(f.source, 'backups/layout', jobs[0], 'host-id'), 'utf8'), 'historical-host')
  } finally {
    await f.dispose()
  }
})

test('缺少 host-id 且历史引用混合时拒绝生成新身份，布局升级不覆盖原状态', async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.source, 'host-id'))
    const legacy = { ...identitySnapshot('historical-host', f.source), operations: {}, events: [] }
    legacy.sessions[0].hostId = 'another-host'
    const file = path.join(f.source, 'control.json')
    await writeJson(file, legacy)
    const before = await readFile(file, 'utf8')
    await assert.rejects(upgradeStorageLayout(f.source), /多个服务身份/)
    assert.equal(await optionalStat(path.join(f.source, 'host-id')), null)
    assert.equal(await optionalStat(path.join(f.source, 'storage.json')), null)
    assert.equal(await readFile(file, 'utf8'), before)
  } finally {
    await f.dispose()
  }
})

test('布局升级发现持久身份与控制状态冲突时，在备份发布前中止', async () => {
  const f = await fixture()
  try {
    await writeJson(path.join(f.source, 'control.json'), identitySnapshot('other-host', f.source))
    await assert.rejects(upgradeStorageLayout(f.source), /服务身份不一致/)
    assert.equal(await readFile(path.join(f.source, 'host-id'), 'utf8'), 'storage-fixture')
    assert.equal(await optionalStat(path.join(f.source, 'storage.json')), null)
    assert.equal(await optionalStat(path.join(f.source, 'backups')), null)
  } finally {
    await f.dispose()
  }
})

test('换根迁移在来源身份冲突时保留空目标，目标身份被修改时拒绝切换目录', async () => {
  const f = await fixture()
  try {
    const snapshotFile = path.join(f.source, 'state/control/snapshot.json')
    await mkdir(path.dirname(snapshotFile), { recursive: true })
    await writeJson(snapshotFile, identitySnapshot('other-host', f.source))
    await assert.rejects(migration(f), /服务身份不一致/)
    assert.deepEqual(await readdir(f.target), [])
    await writeJson(snapshotFile, identitySnapshot('storage-fixture', f.source))
    let committed = false
    await assert.rejects(
      migrateStorage({
        ...f,
        id: 'identity-target-tamper',
        hostId: 'storage-fixture',
        commit: async () => {
          committed = true
        },
        progress: (value) => {
          if (value.stage === 'relocating') writeFileSync(path.join(f.target, 'host-id'), 'other-host')
        },
      }),
      /持久服务身份不匹配/,
    )
    assert.equal(committed, false)
    assert.equal(await readFile(path.join(f.source, 'host-id'), 'utf8'), 'storage-fixture')
    assert.equal(await optionalStat(path.join(f.source, '.pi-meme-relocated.json')), null)
  } finally {
    await f.dispose()
  }
})

test('身份校验只检查事件信封与稳定引用，保留运行事件中的业务数据', async () => {
  const f = await fixture()
  try {
    await mkdir(path.join(f.source, 'state/control'), { recursive: true })
    const event = { hostId: 'storage-fixture', type: 'runtime', value: { hostId: 'business-data' } }
    await writeFile(path.join(f.source, 'state/control/events.jsonl'), `${JSON.stringify({ event })}\n`)
    assert.equal(await ensureHostIdentity(f.source), 'storage-fixture')
  } finally {
    await f.dispose()
  }
})
