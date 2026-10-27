import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'
import type { SessionSelectionResult } from '@pi-meme/contracts/desktop'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ResourceCatalog, ResourceItem } from '@pi-meme/contracts/resources'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createHost } from '../src/service'
import { ResourceStore } from '@pi-meme/resources/server/resource-store'

const content = (name: string, body = '技能正文') => `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${body}\n`
async function setup(t: { onTestFinished: (action: () => Promise<void>) => void }, forbidWorker = false) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pi-host-resources-'))
  const root = path.join(temporary, 'data')
  const cwd = path.join(temporary, 'project')
  await mkdir(cwd)
  const workerMarker = path.join(temporary, 'worker-started')
  const workerPath = path.join(temporary, 'forbidden-worker.mjs')
  await writeFile(
    workerPath,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(workerMarker)}, 'started'); throw new Error('本测试不能启动 Worker')`,
  )
  const host = await createHost({
    dataRoot: root,
    credentials: new MemoryCredentialStorage(),
    ...(forbidWorker ? { workerPath } : {}),
  })
  t.onTestFinished(async () => {
    await host.dispose()
    await rm(temporary, { recursive: true, force: true })
  })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'resources', method, args, sessionId })
  const call = async <T>(method: string, args: unknown[] = [], sessionId?: string) => {
    const response = await rpc(method, args, sessionId)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    return response.result as T
  }
  return { temporary, root, cwd, workerMarker, rpc, call }
}
async function writeSkill(directory: string, name: string, body?: string) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), content(name, body))
}
async function absent(file: string) {
  await assert.rejects(stat(file), { code: 'ENOENT' })
}
function findSkill(catalog: ResourceCatalog, name: string, scope?: ResourceItem['scope']) {
  const item = catalog.items.find(
    (entry) => entry.kind === 'skill' && entry.name === name && (!scope || entry.scope === scope),
  )
  assert.ok(item, `资源目录应包含技能 ${name}`)
  return item
}

test('会话命令合并并发读取并复用资源修订，刷新资源后失效', async (t) => {
  const fixture = await setup(t, true)
  await fixture.call('workspace:select', [{ kind: 'project', cwd: fixture.cwd }])
  const snapshot = vi.spyOn(ResourceStore.prototype, 'snapshot')
  try {
    const [first, second] = await Promise.all([
      fixture.call<PiSlashCommand[]>('pi:commands'),
      fixture.call<PiSlashCommand[]>('pi:commands'),
    ])
    assert.deepEqual(first, second)
    await fixture.call('pi:commands')
    assert.equal(snapshot.mock.calls.length, 1)
    await writeSkill(
      path.join(fixture.root, storageLayoutRelativePaths.skillsDirectory, 'cached-skill'),
      'cached-skill',
    )
    await fixture.call('resources:refresh', [fixture.cwd])
    const updated = await fixture.call<PiSlashCommand[]>('pi:commands')
    assert.ok(updated.some((command) => command.name === 'skill:cached-skill'))
    assert.equal(snapshot.mock.calls.length, 2)
    await absent(fixture.workerMarker)
  } finally {
    snapshot.mockRestore()
  }
})

test('无凭据与Worker的Host目录和UI命令都提供内置Skill Creator且身份同源', async (t) => {
  const fixture = await setup(t, true)
  const catalog = await fixture.call<ResourceCatalog>('resources:catalog', [fixture.cwd])
  const creator = findSkill(catalog, 'skill-creator', 'builtin')
  assert.equal(creator.enabled, true)
  assert.equal(creator.editable, false)
  const commands = await fixture.call<PiSlashCommand[]>('pi:commands')
  const command = commands.find((entry) => entry.name === 'skill:skill-creator')!
  assert.ok(command)
  assert.equal(command.displayName, 'Skill Creator')
  const pluginCreator = findSkill(catalog, 'plugin-creator', 'builtin')
  assert.equal(pluginCreator.editable, false)
  assert.equal(pluginCreator.displayName, 'Plugin Creator')
  assert.equal(command.resourceId, creator.id)
  assert.equal(command.resourceRevision, creator.revision)
  assert.equal(command.sourceInfo.path, creator.path)
  await absent(fixture.workerMarker)
})

test('refresh响应Host技能增改删，忽略旧.pi并让目录与命令共享修订', async (t) => {
  const fixture = await setup(t, true)
  const selected = await fixture.call<SessionSelectionResult>('workspace:select', [
    { kind: 'project', cwd: fixture.cwd },
  ])
  assert.equal(selected.cancelled, false)
  const hostSkill = path.join(fixture.root, storageLayoutRelativePaths.skillsDirectory, 'host-writer')
  await writeSkill(hostSkill, 'host-writer', '首版')
  await writeSkill(path.join(fixture.root, 'pi/skills/legacy-host'), 'legacy-host')
  await writeSkill(path.join(fixture.cwd, '.pi/skills/legacy-project'), 'legacy-project')
  const first = await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd])
  const item = findSkill(first, 'host-writer')
  assert.equal(
    first.items.some((entry) => entry.name.startsWith('legacy-')),
    false,
  )
  const command = (await fixture.call<PiSlashCommand[]>('pi:commands')).find(
    (entry) => entry.name === 'skill:host-writer',
  )!
  assert.equal(command.resourceId, item.id)
  assert.equal(command.resourceRevision, item.revision)
  const oldPath = item.path
  await writeSkill(hostSkill, 'host-writer', '第二版')
  const updated = findSkill(await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd]), 'host-writer')
  assert.equal(updated.id, item.id)
  assert.notEqual(updated.revision, item.revision)
  assert.equal(await readFile(oldPath, 'utf8'), content('host-writer', '首版'))
  await rm(hostSkill, { recursive: true })
  const removed = await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd])
  assert.equal(
    removed.items.some((entry) => entry.name === 'host-writer'),
    false,
  )
  assert.equal(
    (await fixture.call<PiSlashCommand[]>('pi:commands')).some((entry) => entry.name === 'skill:host-writer'),
    false,
  )
  await absent(fixture.workerMarker)
})

test('上传、read和save走真实handler，旧修订冲突不会覆盖已保存正文', async (t) => {
  const fixture = await setup(t, true)
  const imported = await fixture.call<ResourceCatalog>('resources:import', [
    {
      kind: 'skill',
      files: [
        { path: 'SKILL.md', content: content('uploaded') },
        { path: 'references/context.md', content: '上传参考资料' },
      ],
    },
    fixture.cwd,
  ])
  const item = findSkill(imported, 'uploaded')
  const detail = await fixture.call<ResourceItem>('resources:detail', [item.id, fixture.cwd])
  assert.equal(detail.revision, item.revision)
  const read = await fixture.call<{ item: ResourceItem; content: string }>('resources:read-skill', [
    item.id,
    fixture.cwd,
  ])
  assert.equal(read.content, content('uploaded'))
  const saved = await fixture.call<ResourceCatalog>('resources:save-skill', [
    { id: item.id, revision: item.revision, content: content('uploaded', '编辑后正文') },
    fixture.cwd,
  ])
  const current = findSkill(saved, 'uploaded')
  assert.equal(current.id, item.id)
  assert.notEqual(current.revision, item.revision)
  assert.equal(await readFile(path.join(current.baseDir, 'references/context.md'), 'utf8'), '上传参考资料')
  const conflict = await fixture.rpc('resources:save-skill', [
    { id: item.id, revision: item.revision, content: content('uploaded', '过期正文') },
    fixture.cwd,
  ])
  assert.match(conflict.error?.message ?? '', /已更新|修订|重新读取/)
  const unchanged = await fixture.call<{ content: string }>('resources:read-skill', [item.id, fixture.cwd])
  assert.equal(unchanged.content, content('uploaded', '编辑后正文'))
  assert.equal(await readFile(item.path, 'utf8'), content('uploaded'))
  await absent(fixture.workerMarker)
})

test('项目技能覆盖Host，策略写入Host工作区并保留项目源码', async (t) => {
  const fixture = await setup(t, true)
  await fixture.call<SessionSelectionResult>('workspace:select', [{ kind: 'project', cwd: fixture.cwd }])
  await writeSkill(path.join(fixture.root, storageLayoutRelativePaths.skillsDirectory, 'shared'), 'shared', 'Host正文')
  const source = path.join(fixture.cwd, '.agents/skills/shared')
  await writeSkill(source, 'shared', '项目正文')
  const first = await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd])
  const project = findSkill(first, 'shared', 'project')
  assert.equal(findSkill(first, 'shared', 'host').shadowedBy, project.id)
  const command = (await fixture.call<PiSlashCommand[]>('pi:commands')).find((entry) => entry.name === 'skill:shared')!
  assert.equal(command.resourceId, project.id)
  const after = await fixture.call<ResourceCatalog>('resources:set-policy', [
    { id: project.id, scope: 'project', cwd: fixture.cwd, enabled: false },
  ])
  assert.equal(findSkill(after, 'shared', 'project').enabled, false)
  assert.equal(findSkill(after, 'shared', 'host').shadowedBy, undefined)
  const fallback = (await fixture.call<PiSlashCommand[]>('pi:commands')).find((entry) => entry.name === 'skill:shared')!
  assert.equal(fallback.resourceId, findSkill(after, 'shared', 'host').id)
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), content('shared', '项目正文'))
  assert.deepEqual(await readdir(path.join(fixture.cwd, '.agents')), ['skills'])
  const workspacesRoot = path.join(fixture.root, storageLayoutRelativePaths.workspacesConfigDirectory)
  const workspaces = await readdir(workspacesRoot)
  assert.ok(workspaces.length > 0)
  const policies = await Promise.all(
    workspaces.map((directory) =>
      readFile(path.join(workspacesRoot, directory, 'resources.json'), 'utf8').catch(() => ''),
    ),
  )
  assert.ok(policies.some((policy) => policy.includes(project.id)))
  await absent(fixture.workerMarker)
})

test('拒绝原生 Pi 包和扩展上传，保留已有文件且不执行', async (t) => {
  const fixture = await setup(t, true)
  const directory = path.join(fixture.root, 'extensions')
  await mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'old.js')
  const source = 'throw new Error("不应执行")'
  await writeFile(filename, source)
  for (const kind of ['pi-package', 'extension']) {
    const result = await fixture.rpc('resources:import', [
      { kind, name: 'native', files: [{ path: 'index.js', content: source }] },
      fixture.cwd,
    ])
    assert.ok(result.error)
  }
  const catalog = await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd])
  assert.ok(catalog.items.every((entry) => entry.kind === 'skill' || entry.kind === 'app-plugin'))
  assert.equal(await readFile(filename, 'utf8'), source)
  await absent(fixture.workerMarker)
})
