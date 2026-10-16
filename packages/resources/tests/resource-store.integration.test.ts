import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { ResourceStore } from '../src/server/resource-store'
import type { ResourceAppPackage } from '@pi-meme/contracts/resources'

const skill = (name: string, body = '原正文') => `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${body}\n`
async function fixture(t: { onTestFinished: (action: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-resources-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'host')
  const cwd = path.join(directory, 'project')
  await mkdir(cwd, { recursive: true })
  const store = new ResourceStore(root)
  await store.init()
  return { directory, root, cwd, store }
}
async function writeSkill(directory: string, name: string, body?: string) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), skill(name, body))
}

test('导入完整技能、发布可维护来源、快照固定正文并复制辅助文件', async (t) => {
  const { directory, root, cwd, store } = await fixture(t)
  const source = path.join(directory, 'source')
  await writeSkill(source, 'writer')
  await mkdir(path.join(source, 'references'))
  await writeFile(path.join(source, 'references/context.md'), '参考资料')
  const catalog = await store.import({ kind: 'skill', path: source }, cwd)
  const item = catalog.items[0]
  assert.equal(await readFile(path.join(root, 'skills/writer/references/context.md'), 'utf8'), '参考资料')
  const old = await store.snapshot(cwd)
  const release = store.acquire(old)
  await store.saveSkill({ id: item.id, revision: item.revision, content: skill('writer', '新正文') }, cwd)
  assert.equal(await readFile(old.skills[0].path, 'utf8'), skill('writer'))
  assert.equal((await store.catalog(cwd)).items[0].id, item.id)
  assert.equal((await store.readSkill(item.id, cwd)).content, skill('writer', '新正文'))
  const copied = await store.import({ kind: 'skill', path: old.skills[0].baseDir, name: 'writer-copy' }, cwd)
  const copy = copied.items.find((entry) => entry.name === 'writer-copy')!
  assert.equal(await readFile(path.join(copy.baseDir, 'references/context.md'), 'utf8'), '参考资料')
  assert.match((await store.readSkill(copy.id, cwd)).content, /name: writer-copy/)
  release()
  release()
})

test('内置保护、项目覆盖、只读项目及项目策略保存在Host工作区', async (t) => {
  const { root, cwd, store } = await fixture(t)
  await writeSkill(path.join(root, 'skills/shared'), 'shared')
  await writeSkill(path.join(cwd, '.agents/skills/shared'), 'shared', '项目正文')
  await writeSkill(path.join(root, 'builtin-resources/skills/creator'), 'creator')
  await writeSkill(path.join(cwd, '.agents/skills/creator'), 'creator', '项目尝试覆盖')
  const catalog = await store.catalog(cwd)
  const shared = catalog.items.find((entry) => entry.name === 'shared' && entry.scope === 'project')!
  const builtin = catalog.items.find((entry) => entry.scope === 'builtin')!
  assert.equal(catalog.items.find((entry) => entry.name === 'shared' && entry.scope === 'host')?.shadowedBy, shared.id)
  assert.equal(
    catalog.items.find((entry) => entry.name === 'creator' && entry.scope === 'project')?.shadowedBy,
    builtin.id,
  )
  await assert.rejects(
    store.saveSkill({ id: shared.id, revision: shared.revision, content: skill('shared') }, cwd),
    /只读/,
  )
  await store.setPolicy({ id: builtin.id, scope: 'host', enabled: false })
  assert.equal(
    (await store.snapshot(cwd)).skills.some((entry) => entry.name === 'creator'),
    false,
  )
  await store.setPolicy({ id: shared.id, scope: 'project', cwd, enabled: false })
  assert.equal((await store.snapshot(cwd)).skills.find((entry) => entry.name === 'shared')?.scope, 'host')
  assert.deepEqual(await readdir(path.join(cwd, '.agents')), ['skills'])
  const workspace = (await readdir(path.join(root, 'workspaces')))[0]
  assert.match(workspace, /^[a-f\d]{64}$/)
  const policy = JSON.parse(await readFile(path.join(root, 'workspaces', workspace, 'resources.json'), 'utf8'))
  assert.equal(policy[shared.id].enabled, false)
})

test('项目无关refresh不会改变有效snapshot身份，manual技能仍可显式使用', async (t) => {
  const { cwd, store } = await fixture(t)
  const catalog = await store.import({ content: skill('manual') }, cwd)
  await store.setPolicy({ id: catalog.items[0].id, scope: 'host', invocation: 'manual' })
  const before = await store.snapshot(cwd)
  await store.refresh(cwd)
  const after = await store.snapshot(cwd)
  assert.equal(before.id, after.id)
  assert.equal(after.skills[0].invocation, 'manual')
})

test('同来源更新保留身份、同级重复拒绝、删除来源保留旧快照', async (t) => {
  const { directory, root, cwd, store } = await fixture(t)
  const source = path.join(directory, 'source')
  await writeSkill(source, 'writer')
  const first = (await store.import({ path: source }, cwd)).items[0]
  await writeSkill(source, 'writer', '更新')
  const second = (await store.import({ path: source }, cwd)).items[0]
  assert.equal(first.id, second.id)
  await assert.rejects(store.import({ content: skill('writer') }), /重复/)
  const snapshot = await store.snapshot(cwd)
  await store.remove(second.id)
  assert.equal((await store.catalog()).items.length, 0)
  assert.deepEqual(await readdir(path.join(root, 'skills')), [])
  assert.equal(await readFile(snapshot.skills[0].path, 'utf8'), skill('writer', '更新'))
})

test('保存冲突和持久化后的退役失败恢复来源与状态', async (t) => {
  const { root, cwd, store } = await fixture(t)
  const first = (await store.import({ content: skill('writer') }, cwd)).items[0]
  await assert.rejects(store.saveSkill({ id: first.id, revision: '旧版本', content: skill('writer') }, cwd), /已更新/)
  const failing = new ResourceStore(root, {
    onChange: () => {
      throw new Error('退役失败')
    },
  })
  await assert.rejects(
    failing.saveSkill({ id: first.id, revision: first.revision, content: skill('writer', '失败正文') }, cwd),
    /退役失败/,
  )
  const reopened = new ResourceStore(root)
  assert.equal((await reopened.readSkill(first.id, cwd)).content, skill('writer'))
  assert.equal((await reopened.catalog(cwd)).generation, 1)
})

test('拒绝路径越界、软链接、过大上传和应用插件误导入', async (t) => {
  const { directory, store } = await fixture(t)
  await assert.rejects(store.import({ files: [{ path: '../SKILL.md', content: skill('bad') }] }), /路径/)
  await assert.rejects(
    store.import({ files: [{ path: 'SKILL.md', content: 'x'.repeat(32 * 1024 * 1024 + 1) }] }),
    /32 MiB/,
  )
  const linked = path.join(directory, 'linked')
  await mkdir(linked)
  await symlink(directory, path.join(linked, 'escape'))
  await assert.rejects(store.import({ path: linked }), /软链接/)
  await assert.rejects(
    store.import({ files: [{ path: 'package.json', content: JSON.stringify({ name: 'app', piMeme: {} }) }] }),
    /应用插件/,
  )
  assert.equal((await store.catalog()).items.length, 0)
})

test('App资源继承项目策略与代次，项目停用不改变其他项目', async (t) => {
  const { directory, root, cwd } = await fixture(t)
  const appDirectory = path.join(directory, 'app')
  await writeSkill(path.join(appDirectory, 'skills/search'), 'search')
  const app: ResourceAppPackage = {
    id: 'app-tools',
    version: '1.0.0',
    generation: 3,
    directory: appDirectory,
    enabled: true,
    resources: { skills: ['skills'] },
  }
  const store = new ResourceStore(root, { getAppPackages: () => [app] })
  const first = await store.snapshot(cwd)
  assert.equal(first.skills[0].owner.generation, 3)
  await store.setPolicy({ id: 'app:app-tools', scope: 'project', cwd, enabled: false })
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
  assert.equal((await store.snapshot(path.join(directory, 'other-project'))).skills.length, 1)
})

test('Host目录技能编辑和删除，旧快照不受影响', async (t) => {
  const { root, cwd, store } = await fixture(t)
  await writeSkill(path.join(root, 'skills/loose'), 'loose')
  const item = (await store.catalog(cwd)).items[0]
  const snapshot = await store.snapshot(cwd)
  await store.saveSkill({ id: item.id, revision: item.revision, content: skill('loose', '编辑正文') }, cwd)
  assert.equal((await store.catalog(cwd)).items[0].id, item.id)
  assert.equal(await readFile(path.join(root, 'skills/loose/SKILL.md'), 'utf8'), skill('loose', '编辑正文'))
  await store.remove(item.id)
  assert.equal((await store.catalog(cwd)).items.length, 0)
  assert.equal(await readFile(snapshot.skills[0].path, 'utf8'), skill('loose'))
})

test('单文件导入和无效技能诊断可见，损坏ZIP拒绝', async (t) => {
  const { directory, root, cwd, store } = await fixture(t)
  const source = path.join(directory, 'single.md')
  await writeFile(source, skill('single'))
  const item = (await store.import({ path: source }, cwd)).items[0]
  assert.equal((await store.readSkill(item.id, cwd)).content, skill('single'))
  await mkdir(path.join(root, 'skills/invalid'))
  await writeFile(path.join(root, 'skills/invalid/SKILL.md'), '---\nname: invalid\n---\n缺少说明')
  const catalog = await store.catalog(cwd)
  assert.ok(catalog.diagnostics.length > 0)
  await assert.rejects(store.import({ archiveBase64: Buffer.from('不是ZIP').toString('base64') }), /ZIP/)
})

test('ZIP上传展开单层目录、校验CRC并保留辅助资源', async (t) => {
  const { cwd, store } = await fixture(t)
  const archiveBase64 =
    'UEsDBBQAAAAIAEZtTF0pw4/mOQAAADcAAAASAAAAemlwLXNraWxsL1NLSUxMLm1k09XV5cpLzE21UqjKLNAtzs7MyeFKSS1OLsosKMnMz7NSiPIMUHjW1fCieS+XLlDts7WLn01r5wIAUEsDBBQAAAAIAEZtTF36Gbp/DAAAAAoAAAAfAAAAemlwLXNraWxsL3JlZmVyZW5jZXMvY29udGV4dC5tZIvyDFB42t/0oqEZAFBLAQIUAxQAAAAIAEZtTF0pw4/mOQAAADcAAAASAAAAAAAAAAAAAACAAQAAAAB6aXAtc2tpbGwvU0tJTEwubWRQSwECFAMUAAAACABGbUxd+hm6fwwAAAAKAAAAHwAAAAAAAAAAAAAAgAFpAAAAemlwLXNraWxsL3JlZmVyZW5jZXMvY29udGV4dC5tZFBLBQYAAAAAAgACAI0AAACyAAAAAAA='
  const item = (await store.import({ archiveBase64 }, cwd)).items[0]
  assert.equal(item.name, 'zip-skill')
  assert.equal(await readFile(path.join(item.baseDir, 'references/context.md'), 'utf8'), 'ZIP 参考')
  const corrupted = Buffer.from(archiveBase64, 'base64')
  const central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  corrupted.writeUInt32LE(0, central + 16)
  await assert.rejects(store.import({ archiveBase64: corrupted.toString('base64') }), /ZIP/)
})

test('技能嵌套metadata展示字段在目录和readSkill保持一致', async (t) => {
  const { root, cwd, store } = await fixture(t)
  const directory = path.join(root, 'builtin-resources/skills/creator')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'SKILL.md'),
    '---\nname: creator\ndescription: 创建技能\nmetadata:\n  display-name: Skill Creator\n  short-description: 创建或更新技能\n---\n正文',
  )
  const item = (await store.catalog(cwd)).items[0]
  assert.equal(item.displayName, 'Skill Creator')
  assert.equal(item.shortDescription, '创建或更新技能')
  const read = await store.readSkill(item.id, cwd)
  assert.equal(read.item.displayName, item.displayName)
  assert.equal(read.item.shortDescription, item.shortDescription)
  await store.waitForIdle()
})

test('目录分别返回Host与项目策略，reset只清除指定作用域覆盖', async (t) => {
  const { cwd, store } = await fixture(t)
  const id = (await store.import({ content: skill('policy') }, cwd)).items[0].id
  await store.setPolicy({ id, scope: 'host', enabled: false, invocation: 'manual' })
  const overridden = (await store.setPolicy({ id, scope: 'project', cwd, enabled: true, invocation: 'automatic' }))
    .items[0]
  assert.deepEqual(overridden.hostPolicy, { enabled: false, invocation: 'manual' })
  assert.deepEqual(overridden.projectPolicy, { enabled: true, invocation: 'automatic' })
  assert.equal(overridden.enabled, true)
  assert.equal(overridden.invocation, 'automatic')
  const inherited = (await store.setPolicy({ id, scope: 'project', cwd, reset: true })).items[0]
  assert.equal(inherited.projectPolicy, undefined)
  assert.deepEqual(inherited.hostPolicy, { enabled: false, invocation: 'manual' })
  assert.equal(inherited.enabled, false)
  assert.equal(inherited.invocation, 'manual')
  const defaults = (await store.setPolicy({ id, scope: 'host', reset: true })).items[0]
  assert.equal(defaults.hostPolicy, undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.invocation, 'automatic')
})

test('完整本地技能保留脚本执行权限，权限变更产生新修订', async (t) => {
  const { directory, root, cwd, store } = await fixture(t)
  const source = path.join(directory, 'executable')
  await writeSkill(source, 'executable')
  await mkdir(path.join(source, 'scripts'))
  const script = path.join(source, 'scripts/run.sh')
  await writeFile(script, '#!/bin/sh\nprintf ok\n')
  await chmod(script, 0o751)
  const first = (await store.import({ kind: 'skill', path: source }, cwd)).items[0]
  assert.equal((await stat(path.join(first.baseDir, 'scripts/run.sh'))).mode & 0o777, 0o751)
  assert.equal((await stat(path.join(root, 'skills/executable/scripts/run.sh'))).mode & 0o777, 0o751)
  await chmod(script, 0o644)
  const second = (await store.import({ kind: 'skill', path: source }, cwd)).items[0]
  assert.notEqual(second.revision, first.revision)
  assert.equal((await stat(path.join(first.baseDir, 'scripts/run.sh'))).mode & 0o777, 0o751)
  assert.equal((await stat(path.join(second.baseDir, 'scripts/run.sh'))).mode & 0o777, 0o644)
})

test('ZIP上传保留脚本执行权限', async (t) => {
  const { cwd, store } = await fixture(t)
  const archiveBase64 =
    'UEsDBBQAAAAAAAAAIQAwbhMAOwAAADsAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogemlwLWV4ZWN1dGFibGUKZGVzY3JpcHRpb246IFpJUCDohJrmnKwKLS0tCuato+aWh1BLAwQUAAAAAAAAACEAwLzbYxQAAAAUAAAADgAAAHNjcmlwdHMvcnVuLnNoIyEvYmluL3NoCnByaW50ZiBvawpQSwECFAMUAAAAAAAAACEAMG4TADsAAAA7AAAACAAAAAAAAAAAAAAApIEAAAAAU0tJTEwubWRQSwECFAMUAAAAAAAAACEAwLzbYxQAAAAUAAAADgAAAAAAAAAAAAAA6YFhAAAAc2NyaXB0cy9ydW4uc2hQSwUGAAAAAAIAAgByAAAAoQAAAAAA'
  const item = (await store.import({ archiveBase64 }, cwd)).items[0]
  assert.equal((await stat(path.join(item.baseDir, 'scripts/run.sh'))).mode & 0o777, 0o751)
})

test('项目路径别名共享资源身份、snapshot与项目策略', async (t) => {
  const { directory, cwd, store } = await fixture(t)
  await writeSkill(path.join(cwd, '.agents/skills/aliased'), 'aliased')
  const alias = path.join(directory, 'alias')
  await symlink(cwd, alias)
  const normal = await store.snapshot(cwd)
  const aliased = await store.snapshot(alias)
  assert.equal(aliased.id, normal.id)
  assert.equal(aliased.skills[0].id, normal.skills[0].id)
  await store.setPolicy({ id: normal.skills[0].id, scope: 'project', cwd: alias, enabled: false })
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
})

test('内置技能允许Host和项目启停与manual策略，停用仍保留名称保护', async (t) => {
  const { root, cwd, store } = await fixture(t)
  await writeSkill(path.join(root, 'builtin-resources/skills/creator'), 'creator')
  await writeSkill(path.join(root, 'skills/creator'), 'creator', '外部正文')
  const builtin = (await store.catalog(cwd)).items.find((item) => item.scope === 'builtin')!
  await store.setPolicy({ id: builtin.id, scope: 'host', invocation: 'manual' })
  assert.equal((await store.snapshot(cwd)).skills[0].invocation, 'manual')
  await store.setPolicy({ id: builtin.id, scope: 'project', cwd, invocation: 'automatic' })
  assert.equal((await store.snapshot(cwd)).skills[0].invocation, 'automatic')
  await store.setPolicy({ id: builtin.id, scope: 'host', enabled: false })
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
  assert.equal((await store.catalog(cwd)).items.find((item) => item.scope === 'host')?.shadowedBy, builtin.id)
  await store.setPolicy({ id: builtin.id, scope: 'project', cwd, enabled: true })
  const snapshot = await store.snapshot(cwd)
  assert.equal(snapshot.skills.length, 1)
  assert.equal(snapshot.skills[0].id, builtin.id)
  const otherCwd = path.join(root, 'other-project')
  await mkdir(otherCwd)
  assert.equal((await store.snapshot(otherCwd)).skills.length, 0)
  const restoredStore = new ResourceStore(root)
  await restoredStore.init()
  assert.equal((await restoredStore.snapshot(cwd)).skills[0].id, builtin.id)
  await store.setPolicy({ id: builtin.id, scope: 'project', cwd, reset: true })
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
  await store.setPolicy({ id: builtin.id, scope: 'host', reset: true })
  await store.setPolicy({ id: builtin.id, scope: 'project', cwd, enabled: false })
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
  assert.equal((await store.snapshot(otherCwd)).skills[0].id, builtin.id)
  await store.setPolicy({ id: builtin.id, scope: 'project', cwd, reset: true })
  assert.equal((await store.snapshot(cwd)).skills[0].id, builtin.id)
  await assert.rejects(store.remove(builtin.id), /不能.*删除/)
  await assert.rejects(
    store.saveSkill({ id: builtin.id, revision: builtin.revision, content: skill('creator') }, cwd),
    /只读/,
  )
})

test('不同Host中的同路径技能身份不同但内容修订相同', async (t) => {
  const { root, cwd } = await fixture(t)
  await writeSkill(path.join(root, 'skills/shared'), 'shared')
  const first = new ResourceStore(root, { hostId: 'host-first' })
  const second = new ResourceStore(root, { hostId: 'host-second' })
  const left = await first.catalog(cwd)
  const right = await second.catalog(cwd)
  assert.equal(left.hostId, 'host-first')
  assert.equal(right.hostId, 'host-second')
  assert.notEqual(left.items[0].id, right.items[0].id)
  assert.equal(left.items[0].revision, right.items[0].revision)
})

test('无附带资源的App项目开关改变snapshot身份并保留禁用项', async (t) => {
  const { directory, root, cwd } = await fixture(t)
  const app: ResourceAppPackage = {
    id: 'agent-only-app',
    version: '1.0.0',
    generation: 2,
    directory: path.join(directory, 'app'),
    enabled: true,
  }
  const store = new ResourceStore(root, { getAppPackages: () => [app] })
  const original = await store.snapshot(cwd)
  assert.equal(original.skills.length, 0)
  assert.equal(original.appPlugins?.[0].enabled, true)
  await store.setPolicy({ id: 'app:agent-only-app', scope: 'project', cwd, enabled: false })
  const disabled = await store.snapshot(cwd)
  assert.notEqual(disabled.id, original.id)
  assert.equal(disabled.appPlugins?.length, 1)
  assert.equal(disabled.appPlugins?.[0].enabled, false)
  assert.equal(original.appPlugins?.[0].enabled, true)
  assert.equal(app.enabled, true)
  const elsewhere = await store.snapshot(path.join(directory, 'another-project'))
  assert.equal(elsewhere.appPlugins?.[0].enabled, true)
  await store.setPolicy({ id: 'app:agent-only-app', scope: 'project', cwd, reset: true })
  assert.equal((await store.snapshot(cwd)).id, original.id)
  app.generation = 3
  assert.notEqual((await store.snapshot(cwd)).id, original.id)
})

test('Web技能上传显式更新完整辅助文件，身份不变且过期修订拒绝', async (t) => {
  const { root, cwd, store } = await fixture(t)
  const files = [
    { path: 'SKILL.md', content: skill('web-writer', '首版') },
    { path: 'references/context.md', content: '首版资料' },
    { path: 'references/obsolete.md', content: '待删除资料' },
  ]
  const first = (await store.import({ kind: 'skill', files }, cwd)).items[0]
  await assert.rejects(store.import({ kind: 'skill', files }, cwd), /重复/)
  const replacement = [
    { path: 'SKILL.md', content: skill('web-writer', '更新版') },
    { path: 'references/context.md', content: '更新资料' },
    { path: 'scripts/check.ts', content: 'console.log(1)' },
  ]
  const catalog = await store.import(
    { kind: 'skill', files: replacement, replace: { id: first.id, revision: first.revision } },
    cwd,
  )
  const current = catalog.items[0]
  assert.equal(current.id, first.id)
  assert.equal(current.owner.id, first.owner.id)
  assert.notEqual(current.revision, first.revision)
  assert.equal(await readFile(path.join(root, 'skills/web-writer/references/context.md'), 'utf8'), '更新资料')
  assert.equal(await readFile(path.join(current.baseDir, 'scripts/check.ts'), 'utf8'), 'console.log(1)')
  await assert.rejects(stat(path.join(root, 'skills/web-writer/references/obsolete.md')), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(first.baseDir, 'references/obsolete.md'), 'utf8'), '待删除资料')
  await assert.rejects(
    store.import({ kind: 'skill', files, replace: { id: first.id, revision: first.revision } }, cwd),
    /已更新/,
  )
  assert.equal((await store.catalog(cwd)).generation, catalog.generation)
  assert.equal((await store.readSkill(first.id, cwd)).content, skill('web-writer', '更新版'))
})

test('显式更新拒绝技能改名、类型变化、内置、项目和App资源', async (t) => {
  const { root, cwd, store } = await fixture(t)
  const first = (await store.import({ content: skill('replace-guard') }, cwd)).items[0]
  await assert.rejects(
    store.import({ content: skill('another-skill'), replace: { id: first.id, revision: first.revision } }, cwd),
    /名称.*原技能一致/,
  )
  await assert.rejects(
    store.import(
      {
        kind: 'extension' as never,
        files: [{ path: 'replace-guard.ts', content: 'export default () => {}' }],
        replace: { id: first.id, revision: first.revision },
      },
      cwd,
    ),
    /类型无效/,
  )
  await writeSkill(path.join(root, 'builtin-resources/skills/builtin'), 'builtin')
  await writeSkill(path.join(cwd, '.agents/skills/project'), 'project')
  const catalog = await store.catalog(cwd)
  for (const item of catalog.items.filter((entry) => entry.scope !== 'host'))
    await assert.rejects(
      store.import({ content: skill(item.name), replace: { id: item.id, revision: item.revision } }, cwd),
      /只能更新 Host 用户/,
    )
  const app: ResourceAppPackage = { id: 'app', version: '1', generation: 1, directory: root, enabled: true }
  const withApp = new ResourceStore(root, { getAppPackages: () => [app] })
  await assert.rejects(
    withApp.import({ content: skill('app'), replace: { id: 'app:app', revision: '1:1' } }, cwd),
    /只能更新 Host 用户/,
  )
  assert.equal((await store.readSkill(first.id, cwd)).content, skill('replace-guard'))
})

test('ZIP显式更新使用原管理目录并保留完整辅助文件', async (t) => {
  const { cwd, store } = await fixture(t)
  const first = (await store.import({ content: skill('zip-skill', '首版') }, cwd)).items[0]
  const archiveBase64 =
    'UEsDBBQAAAAIAEZtTF0pw4/mOQAAADcAAAASAAAAemlwLXNraWxsL1NLSUxMLm1k09XV5cpLzE21UqjKLNAtzs7MyeFKSS1OLsosKMnMz7NSiPIMUHjW1fCieS+XLlDts7WLn01r5wIAUEsDBBQAAAAIAEZtTF36Gbp/DAAAAAoAAAAfAAAAemlwLXNraWxsL3JlZmVyZW5jZXMvY29udGV4dC5tZIvyDFB42t/0oqEZAFBLAQIUAxQAAAAIAEZtTF0pw4/mOQAAADcAAAASAAAAAAAAAAAAAACAAQAAAAB6aXAtc2tpbGwvU0tJTEwubWRQSwECFAMUAAAACABGbUxd+hm6fwwAAAAKAAAAHwAAAAAAAAAAAAAAgAFpAAAAemlwLXNraWxsL3JlZmVyZW5jZXMvY29udGV4dC5tZFBLBQYAAAAAAgACAI0AAACyAAAAAAA='
  const catalog = await store.import({ archiveBase64, replace: { id: first.id, revision: first.revision } }, cwd)
  const item = catalog.items[0]
  assert.equal(item.id, first.id)
  assert.equal(item.sourcePath, first.sourcePath)
  assert.notEqual(item.revision, first.revision)
  assert.equal(await readFile(path.join(item.baseDir, 'references/context.md'), 'utf8'), 'ZIP 参考')
  assert.equal(await readFile(first.path, 'utf8'), skill('zip-skill', '首版'))
})

test('openai.yaml提供显示与manual默认，显式策略优先且辅助文件改变修订', async (t) => {
  const { root, cwd, store } = await fixture(t)
  const directory = path.join(root, 'skills/yaml-skill')
  await writeSkill(directory, 'yaml-skill')
  await mkdir(path.join(directory, 'agents'))
  const yaml = path.join(directory, 'agents/openai.yaml')
  await writeFile(
    yaml,
    'interface:\n  display_name: YAML显示名称\n  short_description: YAML简短说明\npolicy:\n  allow_implicit_invocation: false\n',
  )
  const first = (await store.catalog(cwd)).items[0]
  assert.equal(first.displayName, 'YAML显示名称')
  assert.equal(first.shortDescription, 'YAML简短说明')
  assert.equal(first.invocation, 'manual')
  assert.equal(first.defaultPolicy.invocation, 'manual')
  assert.equal((await store.readSkill(first.id, cwd)).item.displayName, 'YAML显示名称')
  await store.setPolicy({ id: first.id, scope: 'host', invocation: 'automatic' })
  assert.equal((await store.snapshot(cwd)).skills[0].invocation, 'automatic')
  await store.setPolicy({ id: first.id, scope: 'project', cwd, invocation: 'manual' })
  assert.equal((await store.snapshot(cwd)).skills[0].invocation, 'manual')
  await store.setPolicy({ id: first.id, scope: 'project', cwd, reset: true })
  assert.equal((await store.snapshot(cwd)).skills[0].invocation, 'automatic')
  await store.setPolicy({ id: first.id, scope: 'host', reset: true })
  assert.equal((await store.snapshot(cwd)).skills[0].invocation, 'manual')
  await writeFile(yaml, 'policy:\n  allow_implicit_invocation: true\n')
  const changed = (await store.refresh(cwd)).items[0]
  assert.equal(changed.id, first.id)
  assert.notEqual(changed.revision, first.revision)
  assert.equal(changed.invocation, 'automatic')
  assert.match(await readFile(path.join(first.baseDir, 'agents/openai.yaml'), 'utf8'), /false/)
  await writeFile(
    path.join(directory, 'SKILL.md'),
    skill('yaml-skill').replace('description:', 'disable-model-invocation: true\ndescription:'),
  )
  assert.equal((await store.catalog(cwd)).items[0].invocation, 'manual')
})

test('openai.yaml无效语法与字段给出具体诊断，保留技能并采用manual默认', async (t) => {
  const { root, cwd, store } = await fixture(t)
  const directory = path.join(root, 'skills/yaml-invalid')
  await writeSkill(directory, 'yaml-invalid')
  await mkdir(path.join(directory, 'agents'))
  const yaml = path.join(directory, 'agents/openai.yaml')
  await writeFile(
    yaml,
    'interface:\n  display_name: 42\n  short_description: []\npolicy:\n  allow_implicit_invocation: "false"\n',
  )
  let item = (await store.catalog(cwd)).items[0]
  assert.equal(item.invocation, 'manual')
  for (const field of ['interface.display_name', 'interface.short_description', 'policy.allow_implicit_invocation'])
    assert.ok(item.diagnostics.some((value) => value.includes('agents/openai.yaml') && value.includes(field)))
  await writeFile(yaml, 'interface: [\n')
  item = (await store.catalog(cwd)).items[0]
  assert.equal(item.invocation, 'manual')
  assert.ok(item.diagnostics.some((value) => value.includes('agents/openai.yaml') && value.includes('YAML 解析失败')))
  await writeFile(yaml, 'interface: 42\npolicy: []\n')
  item = (await store.catalog(cwd)).items[0]
  assert.ok(item.diagnostics.some((value) => value.includes('interface 必须是字段映射')))
  assert.ok(item.diagnostics.some((value) => value.includes('policy 必须是字段映射')))
  await writeFile(yaml, 'interface:\n  display_name: 已修复\npolicy:\n  allow_implicit_invocation: true\n')
  item = (await store.catalog(cwd)).items[0]
  assert.equal(item.displayName, '已修复')
  assert.equal(item.invocation, 'automatic')
  assert.deepEqual(item.diagnostics, [])
})

test('同一作用域重复技能全部诊断并退出快照，停用重复项后恢复且跨作用域仍覆盖', async (t) => {
  const { root, cwd, store } = await fixture(t)
  await writeSkill(path.join(root, 'skills/first'), 'duplicate')
  await writeSkill(path.join(root, 'skills/second'), 'duplicate')
  const catalog = await store.catalog(cwd)
  assert.equal(catalog.items.length, 2)
  assert.ok(
    catalog.items.every((item) => !item.enabled && item.diagnostics.some((value) => value.includes('多个同名技能'))),
  )
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
  await store.setPolicy({ id: catalog.items[1].id, scope: 'host', enabled: false })
  assert.equal((await store.snapshot(cwd)).skills[0].id, catalog.items[0].id)
  await writeSkill(path.join(cwd, '.agents/skills/project'), 'duplicate')
  const project = (await store.catalog(cwd)).items.find((item) => item.scope === 'project')!
  assert.equal((await store.snapshot(cwd)).skills[0].id, project.id)
  await store.setPolicy({ id: project.id, scope: 'project', cwd, enabled: false })
  assert.equal((await store.snapshot(cwd)).skills[0].id, catalog.items[0].id)
  await store.setPolicy({ id: catalog.items[1].id, scope: 'host', reset: true })
  assert.equal((await store.snapshot(cwd)).skills.length, 0)
})

test('资源中心忽略旧裸扩展与 Pi 包记录，保留原文件并拒绝旧导入类型', async (t) => {
  const { root, cwd } = await fixture(t)
  const legacy = path.join(root, 'extensions/legacy.ts')
  const project = path.join(cwd, '.agents/extensions/project.ts')
  for (const file of [legacy, project]) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'throw new Error("不能执行旧扩展")')
  }
  await mkdir(path.join(root, 'resources'), { recursive: true })
  await writeFile(
    path.join(root, 'resources/state.json'),
    JSON.stringify({
      generation: 1,
      imports: [{ id: 'old', kind: 'pi-package', directory: path.dirname(legacy), sourcePath: legacy, name: 'old' }],
      policies: {},
    }),
  )
  const store = new ResourceStore(root)
  assert.deepEqual((await store.catalog(cwd)).items, [])
  assert.deepEqual((await store.catalog(cwd)).diagnostics, [])
  assert.equal(await readFile(legacy, 'utf8'), 'throw new Error("不能执行旧扩展")')
  assert.equal(await readFile(project, 'utf8'), 'throw new Error("不能执行旧扩展")')
  for (const kind of ['extension', 'pi-package'])
    await assert.rejects(store.import({ kind: kind as never, content: 'export default () => {}' }), /类型无效/)
})
