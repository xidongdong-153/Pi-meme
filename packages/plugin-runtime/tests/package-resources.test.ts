import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { packPlugin, readPluginManifest, unpackPlugin, type PluginPackage } from '../src/package'
import { PluginManager } from '../src/manager'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-package-resources-'))
  const source = path.join(root, 'source')
  for (const directory of ['dist/ui', 'skills/review/scripts', 'extensions/review', 'assets'])
    await mkdir(path.join(source, directory), { recursive: true })
  const manifest: PluginManifest = {
    name: 'review-app',
    version: '1.0.0',
    piMeme: {
      sdkVersion: 1,
      ui: 'dist/ui/entry.js',
      display: { name: '代码检查', icon: 'assets/icon.svg' },
      resources: { skills: ['skills/review'], extensions: ['extensions/review'] },
    },
  }
  await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(source, 'dist/ui/entry.js'), 'export function activate() {}')
  await writeFile(
    path.join(source, 'skills/review/SKILL.md'),
    '---\nname: review\ndescription: 检查代码\n---\n运行检查。',
  )
  await writeFile(path.join(source, 'skills/review/scripts/check.ts'), 'export const value = 1')
  await writeFile(path.join(source, 'skills/review/.settings.json'), '{"strict":true}')
  await writeFile(path.join(source, 'extensions/review/index.ts'), 'import "./helper.js"; export default function() {}')
  await writeFile(path.join(source, 'extensions/review/helper.js'), 'export const value = 1')
  await writeFile(path.join(source, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(path.join(source, '.env'), 'FAKE_SECRET=test-only')
  return { root, source, manifest }
}

test('App 包完整保留声明技能、扩展辅助文件和图标，不携带未声明根文件', async () => {
  const { root, source } = await fixture()
  try {
    const target = path.join(root, 'unpacked')
    const buffer = await packPlugin(source)
    const decoded = JSON.parse(gunzipSync(buffer).toString()) as PluginPackage
    assert.equal(decoded.files['.env'], undefined)
    await unpackPlugin(buffer, target)
    assert.match(await readFile(path.join(target, 'skills/review/scripts/check.ts'), 'utf8'), /value = 1/)
    assert.equal(await readFile(path.join(target, 'skills/review/.settings.json'), 'utf8'), '{"strict":true}')
    assert.match(await readFile(path.join(target, 'extensions/review/helper.js'), 'utf8'), /value = 1/)
    assert.match(await readFile(path.join(target, 'assets/icon.svg'), 'utf8'), /<svg/)
    decoded.files['.env'] = Buffer.from('FAKE_SECRET=test-only').toString('base64')
    await assert.rejects(
      unpackPlugin(gzipSync(JSON.stringify(decoded)), path.join(root, 'malicious')),
      /插件包文件无效/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('声明资源拒绝软链接、缺少 SKILL.md 和重复解析到 Agent 的目录', async () => {
  const { root, source, manifest } = await fixture()
  try {
    await symlink(path.join(source, 'assets/icon.svg'), path.join(source, 'skills/review/linked.svg'))
    await assert.rejects(packPlugin(source), /软链接/)
    await rm(path.join(source, 'skills/review/linked.svg'))
    await rm(path.join(source, 'skills/review/SKILL.md'))
    await assert.rejects(readPluginManifest(source), /ENOENT|SKILL.md/)
    await writeFile(path.join(source, 'skills/review/SKILL.md'), '说明')
    await mkdir(path.join(source, 'dist/agent'))
    await writeFile(path.join(source, 'dist/agent/index.js'), 'export default function() {}')
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        ...manifest,
        piMeme: { ...manifest.piMeme, agent: 'dist/agent/index.js', resources: { extensions: ['dist/agent'] } },
      }),
    )
    await assert.rejects(readPluginManifest(source), /重复声明/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('资源插件按项目策略取得租约，更新后旧技能目录保留到租约结束', async () => {
  const { root, source, manifest } = await fixture()
  const manager = new PluginManager({ directory: path.join(root, 'installed'), dataDirectory: path.join(root, 'data') })
  try {
    await manager.loadDirectory(source)
    const excluded = manager.acquire(() => false)
    assert.deepEqual(excluded.retainedIds, [])
    await excluded.release()
    const lease = manager.acquire((id) => id === manifest.name)
    const original = manager.resourcePackages()[0]!
    assert.equal(original.display?.name, '代码检查')
    assert.deepEqual(lease.retainedIds, [manifest.name])
    assert.deepEqual(lease.agentEntries, [])
    assert.deepEqual(lease.descriptors[0]?.resources?.skills, ['skills/review'])
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
    await writeFile(path.join(source, 'skills/review/SKILL.md'), '新版')
    await manager.reload(manifest.name)
    assert.equal(manager.resourcePackages()[0]?.version, '2.0.0')
    assert.match(await readFile(path.join(original.directory, 'skills/review/SKILL.md'), 'utf8'), /运行检查/)
    const child = manager.acquire(undefined, lease.descriptors)
    assert.equal(child.descriptors[0]?.version, '1.0.0')
    assert.equal(child.descriptors[0]?.generation, original.generation)
    await lease.release()
    assert.match(await readFile(path.join(original.directory, 'skills/review/SKILL.md'), 'utf8'), /运行检查/)
    await child.release()
    await assert.rejects(readFile(path.join(original.directory, 'skills/review/SKILL.md'), 'utf8'), /ENOENT/)
    assert.throws(() => manager.acquire(undefined, lease.descriptors), /父会话插件代次已释放/)
    await manager.disable(manifest.name)
    assert.equal(manager.resourcePackages()[0]?.enabled, false)
    assert.ok(manager.getGeneration(manifest.name, 0)?.display?.icon)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
