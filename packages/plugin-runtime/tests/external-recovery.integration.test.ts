import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, access, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { bundleFacets } from '@earendil-works/chord/bundler'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { reservedPluginIds, reservedServiceNames } from '@pi-meme/plugin-sdk/reserved'
import { PluginManager } from '../src/manager'
import { packPlugin } from '../src/package'
import { createHash } from 'node:crypto'
import { emptyPluginGrant, type PluginGrant } from '@pi-meme/plugin-sdk/permissions'
import { gzipSync } from 'node:zlib'

const savedGrants = new Map<string, { policyHash: string; grant: PluginGrant }>()
function operation(name: string, expression: string) {
  return `ctx.registerOperations([{name:${JSON.stringify(name)},inputSchema:{type:'null'},outputSchema:{type:'number'},audience:['ui'],effect:'read',capabilities:[],execute:()=>(${expression})}])`
}
function savedEntry(id: string, source: string) {
  return { id, directory: source, enabled: true, builtin: false, ...savedGrants.get(source) }
}
async function trustInstalled(manager: PluginManager, id: string) {
  const descriptor = manager.list().find((item) => item.id === id)!
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
async function loadTrusted(manager: PluginManager, source: string) {
  const descriptor = await manager.loadDirectory(source)
  return trustInstalled(manager, descriptor.id)
}
function call(manager: PluginManager, pluginId: string, operation: string) {
  const descriptor = manager.list().find((entry) => entry.id === pluginId)
  const generation = descriptor?.generation ?? 0
  const requestId = crypto.randomUUID()
  return manager.callUi(
    'fixture',
    { pluginId, generation, policyHash: descriptor?.policyHash ?? '', operation, input: null, requestId },
    {
      pluginId,
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

async function directory(root: string, id: string, config: Partial<PluginManifest['piMeme']> = {}, create?: string) {
  const target = await mkdtemp(path.join(root, 'source-'))
  const manifest: PluginManifest = {
    name: id,
    version: '1.0.0',
    piMeme: { sdkVersion: 3, agent: { trusted: 'dist/agent/entry.js' }, ui: 'dist/ui/entry.js', ...config },
  }
  await mkdir(path.join(target, 'dist/agent'), { recursive: true })
  await writeFile(path.join(target, 'dist/agent/entry.js'), 'export function activate() {}')
  await mkdir(path.join(target, 'dist/ui'), { recursive: true })
  await writeFile(path.join(target, 'dist/ui/entry.js'), 'export function activate() {}')
  if (create || config.requires?.length || config.provides?.length) {
    manifest.piMeme.server = { trusted: 'dist/server/chord-facets.json' }
    await writeFile(
      path.join(target, 'entry.ts'),
      `import { defineFacet, defineService } from '@earendil-works/chord'
export default defineFacet({ id: ${JSON.stringify(id)}, setup(env) {
  env.provide(defineService(${JSON.stringify(`pi-meme.plugin.module:${id}`)}, { local:true }), {
    create(ctx) { ${create ?? ''} }
  })
} })`,
    )
    await bundleFacets({
      plugin: { id, version: '1.0.0' },
      entries: { server: path.join(target, 'entry.ts') },
      outdir: path.join(target, 'dist/server'),
    })
  }
  await writeFile(path.join(target, 'package.json'), JSON.stringify(manifest))
  const policyHash = createHash('sha256')
    .update(await packPlugin(target))
    .digest('hex')
  savedGrants.set(target, {
    policyHash,
    grant: {
      ...emptyPluginGrant(policyHash),
      revision: 1,
      trusted: { ui: true, agent: true, server: Boolean(manifest.piMeme.server?.trusted) },
    },
  })
  return target
}

async function fixture(reservedHandlers?: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-recovery-'))
  const options = {
    directory: path.join(root, 'installed'),
    dataDirectory: path.join(root, 'data'),
    stateFile: path.join(root, 'state/plugins.json'),
    reservedHandlers,
  }
  const manager = new PluginManager(options)
  await mkdir(options.directory, { recursive: true })
  await mkdir(path.dirname(options.stateFile), { recursive: true })
  return {
    root,
    options,
    manager,
    cleanup: async () => {
      await manager.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('所有内置 ID 在目录、包、恢复和生命周期入口均被拒绝', async () => {
  const f = await fixture()
  try {
    const entries = []
    for (const id of reservedPluginIds) {
      const source = await directory(f.root, id)
      await assert.rejects(f.manager.loadDirectory(source), /内置模块/)
      await assert.rejects(f.manager.installPackage(await packPlugin(source)), /内置模块/)
      for (const operation of ['enable', 'disable', 'remove', 'reload'] as const)
        await assert.rejects(f.manager[operation](id), /内置模块/)
      entries.push({ id, directory: source, builtin: false, enabled: true })
    }
    await writeFile(f.options.stateFile, JSON.stringify(entries))
    await f.manager.restore()
    assert.deepEqual(f.manager.list(), [])
    assert.equal(f.manager.diagnostics().length, reservedPluginIds.length - 2)
    const saved = JSON.parse(await readFile(f.options.stateFile, 'utf8')).records
    assert.equal(saved.length, reservedPluginIds.length)
    for (const entry of entries) await access(entry.directory)
    const lease = f.manager.acquire()
    assert.deepEqual(lease.agentEntries, [])
    await lease.release()
  } finally {
    await f.cleanup()
  }
})

test('旧内置记录不控制运行，manifest builtin 声明不能获得内置身份', async () => {
  const f = await fixture()
  try {
    const source = await directory(f.root, 'declared-builtin', {}, operation('pi:abort', '1'))
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
    manifest.builtin = true
    await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest))
    await assert.rejects(loadTrusted(f.manager, source), /操作描述无效/)
    assert.equal(f.manager.list()[0]?.grant?.trusted.server, false)
    await f.manager.remove('declared-builtin')
    const legacyRecords = reservedPluginIds.map((id) => ({ id, directory: '/missing', enabled: false, builtin: true }))
    await writeFile(f.options.stateFile, JSON.stringify(legacyRecords))
    await f.manager.restore()
    assert.deepEqual(f.manager.list(), [])
    assert.deepEqual(f.manager.diagnostics(), [])
    assert.deepEqual(JSON.parse(await readFile(f.options.stateFile, 'utf8')).records, legacyRecords)
    assert.equal('registerBuiltin' in f.manager, false)
  } finally {
    await f.cleanup()
  }
})

test('内置 service 与 handler 不能由外部提供或覆盖', async () => {
  const f = await fixture(['external:protected', 'host:directories'])
  try {
    for (const name of reservedServiceNames) {
      const source = await directory(f.root, 'external', { provides: [name] })
      await assert.rejects(f.manager.loadDirectory(source), /内置服务/)
      await assert.rejects(f.manager.installPackage(await packPlugin(source)), /内置服务/)
    }
    const provider = await directory(f.root, 'provider', { provides: ['custom'] }, "ctx.provide('custom', {})")
    await loadTrusted(f.manager, provider)
    const override = await directory(f.root, 'external', { provides: ['custom'] }, "ctx.provide('custom', {})")
    await assert.rejects(f.manager.loadDirectory(override), /服务已有提供者/)
    const handler = await directory(f.root, 'external', {}, operation('external:protected', '1'))
    await assert.rejects(loadTrusted(f.manager, handler), /操作描述无效/)
    const hostHandler = await directory(f.root, 'host', {}, operation('host:directories', '1'))
    await assert.rejects(loadTrusted(f.manager, hostHandler), /操作描述无效/)
    assert.deepEqual(f.manager.handlers(), {})
  } finally {
    await f.cleanup()
  }
})

test('坏 JSON、非法字段和重复 ID 保留原清单，后续变更报告错误', async () => {
  for (const contents of [
    '{bad',
    '{}',
    '[{"id":"x","directory":"/x","enabled":"yes"}]',
    '[{"id":"x","directory":"/x","enabled":true},{"id":"x","directory":"/y","enabled":true}]',
  ]) {
    const f = await fixture()
    try {
      const state = f.options.stateFile
      await writeFile(state, contents)
      await f.manager.restore()
      assert.deepEqual(f.manager.list(), [])
      assert.equal(f.manager.diagnostics().length, 1)
      assert.equal(await readFile(state, 'utf8'), contents)
      const source = await directory(f.root, 'healthy')
      await assert.rejects(f.manager.loadDirectory(source), /清单读取失败/)
      assert.equal(await readFile(state, 'utf8'), contents)
    } finally {
      await f.cleanup()
    }
  }
})

test('坏包、依赖缺失、循环、服务冲突和初始化失败隔离，健康组及失败记录重启保留', async () => {
  const f = await fixture()
  let restarted: PluginManager | undefined
  try {
    const cases: Array<[string, string]> = []
    cases.push(['healthy', await directory(f.root, 'healthy', {}, operation('value', '7'))])
    cases.push(['missing', await directory(f.root, 'missing', { requires: ['absent'] })])
    cases.push(['cycle-a', await directory(f.root, 'cycle-a', { requires: ['cycle-b'], provides: ['cycle-a'] })])
    cases.push(['cycle-b', await directory(f.root, 'cycle-b', { requires: ['cycle-a'], provides: ['cycle-b'] })])
    cases.push(['conflict-a', await directory(f.root, 'conflict-a', { provides: ['duplicate'] })])
    cases.push(['conflict-b', await directory(f.root, 'conflict-b', { provides: ['duplicate'] })])
    cases.push(['conflict-user', await directory(f.root, 'conflict-user', { requires: ['duplicate'] })])
    const disposed = path.join(f.root, 'disposed')
    cases.push([
      'throwing',
      await directory(
        f.root,
        'throwing',
        { provides: ['throw-service'] },
        `ctx.onDispose(async () => { const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(disposed)}, '已释放') }); throw new Error('初始化失败')`,
      ),
    ])
    cases.push(['throw-user', await directory(f.root, 'throw-user', { requires: ['throw-service'] })])
    cases.push(['bad-package', await directory(f.root, 'bad-package')])
    await rm(path.join(cases.at(-1)![1], 'dist/agent/entry.js'))
    cases.push(['mismatch', await directory(f.root, 'different-id')])
    const state = f.options.stateFile
    await writeFile(state, JSON.stringify(cases.map(([id, directory]) => savedEntry(id, directory))))
    await f.manager.restore()
    assert.equal(await call(f.manager, 'healthy', 'value'), 7)
    assert.equal(f.manager.diagnostics().length, cases.length - 1)
    for (const item of f.manager.list().filter((item) => item.status === 'failed')) {
      assert.equal(item.ui, undefined)
      assert.equal(item.agent, undefined)
    }
    assert.equal(await readFile(disposed, 'utf8'), '已释放')
    assert.equal(JSON.parse(await readFile(state, 'utf8')).records.length, cases.length)
    const other = await directory(f.root, 'other')
    await f.manager.loadDirectory(other)
    assert.equal(await call(f.manager, 'healthy', 'value'), 7)
    await f.manager.dispose()
    restarted = new PluginManager(f.options)
    await restarted.restore()
    assert.equal(await call(restarted, 'healthy', 'value'), 7)
    assert.equal(restarted.diagnostics().length, cases.length - 1)
    for (const [, source] of cases) await access(source)
  } finally {
    await restarted?.dispose()
    await f.cleanup()
  }
})

test('迁移原子写入失败保留原清单，恢复目录权限后仍拒绝后续变更', { skip: process.getuid?.() === 0 }, async () => {
  const f = await fixture()
  try {
    const executed = path.join(f.root, 'candidate-executed')
    const source = await directory(
      f.root,
      'healthy',
      {},
      `return import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(executed)}, '不得执行'))`,
    )
    const state = f.options.stateFile
    const contents = JSON.stringify([savedEntry('healthy', source)])
    await writeFile(state, contents)
    const stateDir = path.dirname(f.options.stateFile)
    await chmod(stateDir, 0o500)
    await f.manager.restore()
    assert.deepEqual(f.manager.list(), [])
    assert.match(f.manager.diagnostics()[0]!.message, /预留失败/)
    await assert.rejects(access(executed), /ENOENT/)
    await chmod(stateDir, 0o700)
    await assert.rejects(f.manager.disable('healthy'), /后续变更未接纳/)
    assert.deepEqual(f.manager.list(), [])
    assert.equal(await readFile(state, 'utf8'), contents)
  } finally {
    await chmod(path.dirname(f.options.stateFile), 0o700).catch(() => {})
    await f.cleanup()
  }
})

test('SDK 2 旧包只报告升级诊断，不执行代码或删除安装记录与用户数据', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'legacy-source')
    const marker = path.join(f.root, 'legacy-executed')
    await mkdir(path.join(source, 'dist/agent'), { recursive: true })
    await mkdir(path.join(f.options.dataDirectory, 'legacy'), { recursive: true })
    const manifest = {
      name: 'legacy',
      version: '1.0.0',
      type: 'module',
      piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' },
    }
    const code = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '不应执行'); export function activate() {}`
    await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest))
    await writeFile(path.join(source, 'dist/agent/entry.js'), code)
    const data = path.join(f.options.dataDirectory, 'legacy/user.json')
    await writeFile(data, '{"saved":true}')
    await assert.rejects(f.manager.loadDirectory(source), /unsupported-sdk/)
    const archive = gzipSync(
      JSON.stringify({
        format: 'pi-meme-plugin-v1',
        files: {
          'package.json': Buffer.from(JSON.stringify(manifest)).toString('base64'),
          'dist/agent/entry.js': Buffer.from(code).toString('base64'),
        },
      }),
    )
    await assert.rejects(f.manager.installPackage(archive), /unsupported-sdk/)
    const state = f.options.stateFile
    await writeFile(state, JSON.stringify([{ id: 'legacy', directory: source, enabled: true }]))
    await f.manager.restore()
    assert.equal(f.manager.list()[0]?.status, 'failed')
    assert.match(f.manager.diagnostics()[0]?.message ?? '', /unsupported-sdk/)
    assert.equal(JSON.parse(await readFile(state, 'utf8')).records[0]?.id, 'legacy')
    assert.equal(await readFile(data, 'utf8'), '{"saved":true}')
    assert.equal(await readFile(path.join(source, 'dist/agent/entry.js'), 'utf8'), code)
    await assert.rejects(access(marker), /ENOENT/)
  } finally {
    await f.cleanup()
  }
})
