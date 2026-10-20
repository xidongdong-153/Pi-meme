import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { createPlugin } from '../src/create'
import { buildPlugin, packagePlugin, validatePlugin } from '../src/build'
import { PluginManager } from '@pi-meme/plugin-runtime/manager'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'

async function addTrustedServer(directory: string) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as PluginManifest
  manifest.piMeme.server = { ...manifest.piMeme.server, trusted: 'dist/server/chord-facets.json' }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest))
  await writeFile(
    path.join(directory, 'src/server/entry.ts'),
    `export function create(context) { context.registerOperations([{name:'time',inputSchema:{type:'object',additionalProperties:false},outputSchema:{type:'string'},audience:['ui'],effect:'read',capabilities:[],execute:()=>new Date().toISOString()}]) }`,
  )
  const agent = path.join(directory, 'src/agent/restricted.ts')
  await writeFile(
    agent,
    (await readFile(agent, 'utf8')).replace(
      'export function activate(context: RestrictedAgentContext) {',
      `export function activate(context: RestrictedAgentContext) {\n  context.hooks.on('sessionStart', () => {})`,
    ),
  )
}
async function trustInstalled(manager: PluginManager, id: string) {
  const descriptor = manager.list().find((entry) => entry.id === id)!
  return manager.setGrant(id, {
    ...descriptor.grant!,
    expectedRevision: descriptor.grant!.revision,
    policyHash: descriptor.policyHash!,
    trusted: {
      ui: Boolean(descriptor.ui),
      agent: Boolean(descriptor.entries?.agent?.trusted),
      server: Boolean(descriptor.entries?.server?.trusted),
    },
  })
}
function callTime(manager: PluginManager, id: string) {
  const descriptor = manager.list().find((entry) => entry.id === id)!
  const generation = descriptor.generation
  const requestId = crypto.randomUUID()
  return manager.callUi(
    'devkit-fixture',
    { pluginId: id, generation, policyHash: descriptor.policyHash!, operation: 'time', input: {}, requestId },
    {
      pluginId: id,
      generation,
      origin: 'ui',
      target: { hostId: 'fixture-host' },
      mode: 'default',
      accessMode: 'full-access',
      capabilities: [],
      signal: new AbortController().signal,
      requestId,
    },
  )
}

test('模板构建出 Node 工具和浏览器 UI，验证打包并安装服务', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-devkit-'))
  const directory = path.join(root, 'clock')
  const manager = new PluginManager({ directory: path.join(root, 'installed'), dataDirectory: path.join(root, 'data') })
  try {
    await createPlugin(directory, 'clock')
    await addTrustedServer(directory)
    await symlink(
      path.resolve(import.meta.dirname, '../../../node_modules'),
      path.join(directory, 'node_modules'),
      'dir',
    )
    await buildPlugin(directory)
    assert.equal((await validatePlugin(directory)).piMeme.sdkVersion, 3)
    const agent = await readFile(path.join(directory, 'dist/agent/restricted.js'), 'utf8')
    assert.match(agent, /tools\.register/)
    assert.match(agent, /sessionStart/)
    assert.doesNotMatch(agent, /from ["']typebox["']/)
    const ui = await readFile(path.join(directory, 'dist/ui/entry.js'), 'utf8')
    assert.match(ui, /react\/jsx-runtime/)
    assert.doesNotMatch(ui, /module\.exports/)
    assert.match(ui, /location: ["']right["']/)
    const packed = await packagePlugin(directory, path.join(root, 'clock.pim'))
    await manager.installPackage(await readFile(packed))
    await assert.rejects(callTime(manager, 'clock'), /generation-mismatch/)
    await trustInstalled(manager, 'clock')
    assert.match(String(await callTime(manager, 'clock')), /^\d{4}-\d{2}/)
    const artifact = JSON.parse(await readFile(path.join(directory, 'dist/server/chord-facets.json'), 'utf8')) as {
      entries: { server: { file: string } }
    }
    await appendFile(path.join(directory, 'dist/server', artifact.entries.server.file), '\n// 已篡改\n')
    await assert.rejects(validatePlugin(directory), /integrity|hash|sha256|校验/i)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('DevKit 构建和打包保留显式资源目录、辅助脚本与显示图标', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-devkit-resources-'))
  const directory = path.join(root, 'review')
  const manager = new PluginManager({ directory: path.join(root, 'installed'), dataDirectory: path.join(root, 'data') })
  try {
    await createPlugin(directory, 'review')
    await symlink(
      path.resolve(import.meta.dirname, '../../../node_modules'),
      path.join(directory, 'node_modules'),
      'dir',
    )
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as PluginManifest
    manifest.piMeme.resources = { skills: ['skills/review'], assets: ['assets'] }
    manifest.piMeme.display = { name: '代码检查', icon: 'assets/icon.svg' }
    for (const child of ['skills/review/scripts', 'extensions/review', 'assets'])
      await mkdir(path.join(directory, child), { recursive: true })
    await writeFile(
      path.join(directory, 'skills/review/SKILL.md'),
      '---\nname: review\ndescription: 检查代码\n---\n说明',
    )
    await writeFile(path.join(directory, 'skills/review/scripts/check.js'), 'export const check = true')
    await writeFile(path.join(directory, 'extensions/review/index.ts'), 'export default function extension() {}')
    await writeFile(path.join(directory, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest))
    await buildPlugin(directory)
    const packed = await packagePlugin(directory, path.join(root, 'review.pim'))
    const installed = await manager.installPackage(await readFile(packed))
    assert.equal(installed.display?.name, '代码检查')
    assert.equal(
      await readFile(path.join(installed.directory, 'skills/review/scripts/check.js'), 'utf8'),
      'export const check = true',
    )
    assert.match(await readFile(path.join(installed.directory, 'assets/icon.svg'), 'utf8'), /<svg/)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
