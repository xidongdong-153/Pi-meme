import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Snapshot, SessionSelectionResult } from '@pi-meme/contracts/desktop'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ResourceCatalog, ResourceItem } from '@pi-meme/contracts/resources'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createHost } from '../src/service'

const content = (name: string, body = '技能正文') => `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${body}\n`
async function setup(t: { after: (action: () => Promise<void>) => void }, forbidWorker = false) {
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
  t.after(async () => {
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
  await writeSkill(path.join(fixture.root, 'skills/host-writer'), 'host-writer', '首版')
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
  await writeSkill(path.join(fixture.root, 'skills/host-writer'), 'host-writer', '第二版')
  const updated = findSkill(await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd]), 'host-writer')
  assert.equal(updated.id, item.id)
  assert.notEqual(updated.revision, item.revision)
  assert.equal(await readFile(oldPath, 'utf8'), content('host-writer', '首版'))
  await rm(path.join(fixture.root, 'skills/host-writer'), { recursive: true })
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
  await writeSkill(path.join(fixture.root, 'skills/shared'), 'shared', 'Host正文')
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
  const workspaces = await readdir(path.join(fixture.root, 'workspaces'))
  assert.ok(workspaces.length > 0)
  const policies = await Promise.all(
    workspaces.map((directory) =>
      readFile(path.join(fixture.root, 'workspaces', directory, 'resources.json'), 'utf8').catch(() => ''),
    ),
  )
  assert.ok(policies.some((policy) => policy.includes(project.id)))
  await absent(fixture.workerMarker)
})

test('native包可冷索引，未启用及受限会话的读取不执行扩展模块', async (t) => {
  const fixture = await setup(t, true)
  const marker = path.join(fixture.temporary, 'native-executed')
  const sideEffect = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {}`
  const imported = await fixture.call<ResourceCatalog>('resources:import', [
    {
      kind: 'pi-package',
      files: [
        { path: 'package.json', content: JSON.stringify({ name: 'native-fixture', version: '1.0.0' }) },
        { path: 'skills/native-skill/SKILL.md', content: content('native-skill') },
        { path: 'extensions/index.ts', content: sideEffect },
      ],
    },
    fixture.cwd,
  ])
  const extension = imported.items.find((entry) => entry.kind === 'extension' && entry.owner.name === 'native-fixture')!
  assert.ok(extension)
  assert.ok(findSkill(imported, 'native-fixture:native-skill'))
  await absent(marker)
  await fixture.call<ResourceCatalog>('resources:set-policy', [{ id: extension.id, scope: 'host', enabled: false }])
  await fixture.call<ResourceCatalog>('resources:refresh', [fixture.cwd])
  const selected = await fixture.call<SessionSelectionResult>('workspace:select', [
    { kind: 'project', cwd: fixture.cwd },
  ])
  if (selected.cancelled) throw new Error('临时项目选择不能取消')
  const key = selected.snapshot.connection.sessionKey!
  await fixture.call('pi:access-mode', [key, 'read-only'], key)
  const snapshot = await fixture.call<Snapshot>('pi:snapshot')
  assert.equal(snapshot.connection.accessMode, 'read-only')
  const commands = await fixture.call<PiSlashCommand[]>('pi:commands')
  assert.ok(commands.some((entry) => entry.name === 'skill:native-fixture:native-skill'))
  await absent(marker)
  await absent(fixture.workerMarker)
})

test('native单文件上传保留ts、js、mjs文件名并支持正文导入', async (t) => {
  const fixture = await setup(t, true)
  for (const extension of ['ts', 'js', 'mjs']) {
    const name = `native-${extension}`
    const filename = `${name}.${extension}`
    const catalog = await fixture.call<ResourceCatalog>('resources:import', [
      { kind: 'extension', name, files: [{ path: filename, content: 'export default () => {}' }] },
      fixture.cwd,
    ])
    const item = catalog.items.find((entry) => entry.kind === 'extension' && entry.name === name)
    assert.ok(item, `${filename} 应被原生资源发现API识别`)
    assert.equal(path.basename(item.path), filename)
    assert.equal(
      await readFile(path.join(fixture.root, 'extensions', name, filename), 'utf8'),
      'export default () => {}',
    )
  }
  const catalog = await fixture.call<ResourceCatalog>('resources:import', [
    { kind: 'extension', name: 'native-content', content: 'export default () => {}' },
    fixture.cwd,
  ])
  const item = catalog.items.find((entry) => entry.kind === 'extension' && entry.name === 'native-content')
  assert.ok(item)
  assert.equal(path.basename(item.path), 'native-content.ts')
  await absent(fixture.workerMarker)
})
