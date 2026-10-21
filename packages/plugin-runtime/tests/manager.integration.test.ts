import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { PluginManager, type PluginDescriptor, type PluginLease } from '../src/manager'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'
import type { JsonValue, PluginCallContext } from '@pi-meme/plugin-sdk/rpc'
import { assertExternalManifest } from '@pi-meme/plugin-sdk/reserved'
import type { ServerPluginModule, PluginOperation, SharedDataPublisher } from '@pi-meme/plugin-sdk/server'
import { bundleFacets } from '@earendil-works/chord/bundler'
import { packPlugin, unpackPlugin } from '../src/package'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'

// 内存模块显式授予测试代码信任；真实安装用例通过 setGrant 授权，不修改生产默认值。
class FixtureManager extends PluginManager {
  registerFixture(manifest: PluginManifest, module: ServerPluginModule, directory: string) {
    assertExternalManifest(manifest)
    const policyHash = `fixture:${manifest.name}:${manifest.version}`
    const grant = {
      ...emptyPluginGrant(policyHash),
      trusted: { ui: true, server: true, agent: Boolean(manifest.piMeme.agent?.trusted) },
    }
    return (
      this as unknown as {
        replace: (registration: {
          manifest: PluginManifest
          module: ServerPluginModule
          directory: string
          enabled: boolean
          policyHash: string
          grant: typeof grant
        }) => Promise<PluginDescriptor>
      }
    ).replace({ manifest, module, directory, enabled: true, policyHash, grant })
  }
  call(pluginId: string, operation: string, input: JsonValue = null) {
    const descriptor = this.list().find((entry) => entry.id === pluginId)
    const generation = descriptor?.generation ?? 0
    const context = callContext(pluginId, generation, 'ui')
    return this.callUi(
      'fixture',
      {
        pluginId,
        generation,
        policyHash: descriptor?.policyHash ?? '',
        operation,
        input,
        requestId: context.requestId,
      },
      context,
    )
  }
}
function callContext(pluginId: string, generation: number, origin: 'ui' | 'agent'): PluginCallContext {
  return {
    pluginId,
    generation,
    origin,
    target: { hostId: 'fixture-host' },
    mode: 'default',
    accessMode: 'full-access',
    capabilities: [],
    signal: new AbortController().signal,
    requestId: crypto.randomUUID(),
  }
}
function callLease(lease: PluginLease, pluginId: string, operation: string, input: JsonValue = null) {
  const descriptor = lease.descriptors.find((entry) => entry.id === pluginId)
  const generation = descriptor?.generation ?? 0
  return lease.callOperation(pluginId, operation, input, {
    ...callContext(pluginId, generation, 'agent'),
    policyHash: descriptor?.policyHash,
  })
}
function operation(
  name: string,
  execute: (input: JsonValue) => JsonValue,
  outputType: 'string' | 'number' = 'string',
  inputType = 'null',
): PluginOperation {
  return {
    name,
    inputSchema: { type: inputType },
    outputSchema: { type: outputType },
    audience: ['ui', 'agent'],
    effect: 'read',
    capabilities: [],
    execute,
  }
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

function manifest(name: string, version = '1.0.0', provides: string[] = [], requires: string[] = []): PluginManifest {
  return {
    name,
    version,
    piMeme: {
      sdkVersion: 3,
      server: { trusted: 'dist/server/chord-facets.json' },
      ui: 'dist/ui/entry.js',
      provides,
      requires,
    },
  }
}

async function setup(drain?: (pluginIds: string[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-plugins-'))
  await mkdir(path.join(directory, 'state'), { recursive: true })
  const manager = new FixtureManager({
    directory: path.join(directory, 'installed'),
    dataDirectory: path.join(directory, 'data'),
    stateFile: path.join(directory, 'state/plugins.json'),
    drain,
  })
  return {
    directory,
    manager,
    cleanup: async () => {
      await manager.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('更新等待代次租约释放，失败保留旧版本，停用取消处理函数', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const disposed: string[] = []
    await manager.registerFixture(
      { ...manifest('clock'), piMeme: { ...manifest('clock').piMeme, agent: { trusted: 'dist/agent/entry.js' } } },
      {
        create: (context) => {
          context.registerOperations([operation('time', () => 'old')])
          context.onDispose(() => {
            disposed.push('old')
          })
        },
      },
      directory,
    )
    const lease = manager.acquire()
    let completed = false
    const update = manager
      .registerFixture(
        manifest('clock', '2.0.0'),
        {
          create: (context) => {
            context.registerOperations([operation('time', () => 'new')])
          },
        },
        directory,
      )
      .then(() => {
        completed = true
      })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(completed, false)
    assert.equal(manager.list()[0]!.status, 'pending')
    await lease.release()
    await update
    assert.deepEqual(disposed, ['old'])
    assert.equal(await manager.call('clock', 'time'), 'new')
    await assert.rejects(
      manager.registerFixture(
        manifest('clock', '3.0.0'),
        {
          create: () => {
            throw new Error('坏版本')
          },
        },
        directory,
      ),
    )
    assert.equal(manager.list()[0]!.version, '2.0.0')
    assert.equal(await manager.call('clock', 'time'), 'new')
    await manager.disable('clock')
    assert.deepEqual(manager.handlers(), {})
    await assert.rejects(manager.call('clock', 'time'), /generation-mismatch/)
    await manager.enable('clock')
    assert.equal(await manager.call('clock', 'time'), 'new')
  } finally {
    await cleanup()
  }
})

test('有必需服务使用者时拒绝拔掉唯一提供插件，服务更新后使用新实现', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    await manager.registerFixture(
      manifest('provider', '1.0.0', ['clock']),
      {
        create: (context) => {
          context.provide('clock', { now: () => 1 })
        },
      },
      directory,
    )
    await manager.registerFixture(
      manifest('consumer', '1.0.0', [], ['clock']),
      {
        create: (context) => {
          const clock = context.services.require<{ now: () => number }>('clock')
          context.registerOperations([operation('now', () => clock.now(), 'number')])
        },
      },
      directory,
    )
    await assert.rejects(manager.remove('provider'), /consumer/)
    await assert.rejects(manager.disable('provider'), /consumer/)
    await manager.registerFixture(
      manifest('provider', '2.0.0', ['clock']),
      {
        create: (context) => {
          context.provide('clock', { now: () => 2 })
        },
      },
      directory,
    )
    assert.equal(await manager.call('consumer', 'now'), 2)
    await manager.disable('consumer')
    await manager.remove('provider')
  } finally {
    await cleanup()
  }
})

test('打包安装只处理构建产物，拒绝路径越界包', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const source = path.join(directory, 'source')
    await mkdir(path.join(source, 'dist/server'), { recursive: true })
    await mkdir(path.join(source, 'dist/ui'), { recursive: true })
    await writeFile(path.join(source, 'dist/ui/entry.js'), 'export function activate() {}')
    await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest('external')))
    await writeFile(path.join(source, '.env'), 'FAKE_SECRET=test-only')
    await writeFile(path.join(source, 'secret.pem'), 'test-only-private-key')
    await writeFile(
      path.join(source, 'entry.ts'),
      `import { defineFacet, defineService } from '@earendil-works/chord'
export default defineFacet({ id:'external-module', setup(env) { env.provide(defineService('pi-meme.plugin.module:external', {local:true}), {
  create(ctx) { ctx.registerOperations([{name:'time',inputSchema:{type:'null'},outputSchema:{type:'string'},audience:['ui'],effect:'read',capabilities:[],execute:()=> 'ok'}]) }
}) } })`,
    )
    await bundleFacets({
      plugin: { id: 'external' },
      entries: { server: path.join(source, 'entry.ts') },
      outdir: path.join(source, 'dist/server'),
    })
    const buffer = await packPlugin(source)
    const installed = await manager.installPackage(buffer)
    const { access } = await import('node:fs/promises')
    await assert.rejects(access(path.join(installed.directory, '.env')))
    await assert.rejects(access(path.join(installed.directory, 'secret.pem')))
    await assert.rejects(access(path.join(installed.directory, 'entry.ts')))
    assert.equal(installed.id, 'external')
    await assert.rejects(manager.call('external', 'time'), /generation-mismatch/)
    await trustInstalled(manager, 'external')
    assert.equal(await manager.call('external', 'time'), 'ok')
    const { gzipSync } = await import('node:zlib')
    await assert.rejects(
      unpackPlugin(
        gzipSync(JSON.stringify({ format: 'pi-meme-plugin-v1', files: { '../escape': 'eA==' } })),
        path.join(directory, 'bad'),
      ),
      /无效/,
    )
    await manager.remove('external')
    assert.deepEqual(manager.handlers(), {})
    await assert.rejects(manager.call('external', 'time'), /generation-mismatch/)
  } finally {
    await cleanup()
  }
})

test('纯 Agent 新旧代次并存，新会话取新版本，无关服务更新不等待 Agent', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const agentManifest: PluginManifest = {
      name: 'agent',
      version: '1.0.0',
      piMeme: { sdkVersion: 3, agent: { trusted: 'dist/agent/entry.js' } },
    }
    await manager.registerFixture(agentManifest, { create() {} }, directory)
    const oldLease = manager.acquire()
    const oldGeneration = oldLease.agentEntries[0]!.generation
    await manager.registerFixture({ ...agentManifest, version: '2.0.0' }, { create() {} }, directory)
    const newLease = manager.acquire()
    assert.notEqual(newLease.agentEntries[0]!.generation, oldGeneration)
    assert.equal(manager.getGeneration('agent', oldGeneration)?.version, '1.0.0')
    assert.equal(oldLease.descriptors[0]!.version, '1.0.0')
    assert.equal(manager.isGrantCurrent('agent', oldGeneration, oldLease.descriptors[0]!.grant!.revision), true)
    const inherited = manager.acquire(undefined, oldLease.descriptors)
    await inherited.release()
    await manager.registerFixture(
      manifest('git'),
      {
        create: (context) => {
          context.registerOperations([operation('diff', () => 1, 'number')])
        },
      },
      directory,
    )
    await manager.registerFixture(
      manifest('git', '2.0.0'),
      {
        create: (context) => {
          context.registerOperations([operation('diff', () => 2, 'number')])
        },
      },
      directory,
    )
    assert.equal(await manager.call('git', 'diff'), 2)
    assert.deepEqual(newLease.retainedIds, ['agent'])
    await oldLease.release()
    assert.equal(manager.getGeneration('agent', oldGeneration), undefined)
    await newLease.release()
  } finally {
    await cleanup()
  }
})

test('外部目录停用经重启保留，源目录改动不影响已加载快照', async () => {
  const { directory, manager, cleanup } = await setup()
  let restarted: FixtureManager | undefined
  try {
    const source = path.join(directory, 'external-source')
    await mkdir(path.join(source, 'dist/ui'), { recursive: true })
    const uiManifest: PluginManifest = {
      name: 'ui-plugin',
      version: '1.0.0',
      piMeme: { sdkVersion: 3, ui: 'dist/ui/entry.js' },
    }
    await writeFile(path.join(source, 'package.json'), JSON.stringify(uiManifest))
    await writeFile(path.join(source, 'dist/ui/entry.js'), 'export function activate() { return "old" }')
    const loaded = await manager.loadDirectory(source)
    assert.notEqual(loaded.directory, source)
    await writeFile(path.join(source, 'dist/ui/entry.js'), 'export function activate() { return "new" }')
    assert.match(
      await (await import('node:fs/promises')).readFile(path.join(loaded.directory, 'dist/ui/entry.js'), 'utf8'),
      /old/,
    )
    await manager.disable('ui-plugin')
    await manager.dispose()
    restarted = new FixtureManager({
      directory: path.join(directory, 'installed'),
      dataDirectory: path.join(directory, 'data'),
      stateFile: path.join(directory, 'state/plugins.json'),
    })
    await restarted.restore()
    assert.equal(restarted.list().find((item) => item.id === 'ui-plugin')?.enabled, false)
    assert.deepEqual(restarted.handlers(), {})
  } finally {
    await restarted?.dispose()
    await cleanup()
  }
})

test('持久化失败不释放旧服务，依赖组先释放使用者再释放提供者', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const order: string[] = []
    await manager.registerFixture(
      manifest('provider', '1.0.0', ['clock']),
      {
        create: (context) => {
          context.provide('clock', { now: () => 1 })
          context.onDispose(() => {
            order.push('provider')
          })
        },
      },
      directory,
    )
    await manager.registerFixture(
      manifest('consumer', '1.0.0', [], ['clock']),
      {
        create: (context) => {
          const clock = context.services.require<{ now: () => number }>('clock')
          context.registerOperations([operation('now', () => clock.now(), 'number')])
          context.onDispose(() => {
            order.push('consumer')
          })
        },
      },
      directory,
    )
    order.length = 0
    const state = path.join(directory, 'state/plugins.json')
    await rm(state)
    await mkdir(state)
    await assert.rejects(
      manager.registerFixture(
        manifest('provider', '2.0.0', ['clock']),
        {
          create: (context) => {
            context.provide('clock', { now: () => 2 })
          },
        },
        directory,
      ),
    )
    assert.equal(await manager.call('consumer', 'now'), 1)
    assert.deepEqual(order, [])
    await rm(state, { recursive: true })
    await manager.disable('consumer')
    assert.deepEqual(order, ['consumer', 'provider'])
  } finally {
    await cleanup()
  }
})

test.each(['disable', 'remove'] as const)(
  '%s 后旧纯 Agent 代次仅可读历史，不再具有有效授权或派生租约',
  async (action) => {
    const { directory, manager, cleanup } = await setup()
    let lease: PluginLease | undefined
    try {
      const entry: PluginManifest = {
        name: 'retired-agent',
        version: '1.0.0',
        piMeme: { sdkVersion: 3, agent: { restricted: 'dist/agent.js' } },
      }
      const installed = await manager.registerFixture(entry, { create() {} }, directory)
      lease = manager.acquire()
      assert.equal(manager.isGrantCurrent(entry.name, installed.generation, installed.grant!.revision), true)
      await manager[action](entry.name)
      assert.equal(manager.getGeneration(entry.name, installed.generation)?.enabled, true)
      assert.equal(manager.isGrantCurrent(entry.name, installed.generation, installed.grant!.revision), false)
      assert.throws(() => manager.acquire(undefined, lease!.descriptors), /policy-changed/)
    } finally {
      await lease?.release()
      await cleanup()
    }
  },
)

test('目录重新构建后 reload 取新版，旧 Agent 租约仍读取旧快照', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const source = path.join(directory, 'source')
    await mkdir(path.join(source, 'dist/agent'), { recursive: true })
    const agentManifest: PluginManifest = {
      name: 'agent',
      version: '1.0.0',
      piMeme: { sdkVersion: 3, agent: { trusted: 'dist/agent/entry.js' } },
    }
    await writeFile(path.join(source, 'package.json'), JSON.stringify(agentManifest))
    await writeFile(path.join(source, 'dist/agent/entry.js'), 'export function activate() { return "old" }')
    await manager.loadDirectory(source)
    const lease = manager.acquire()
    const oldPath = lease.agentEntries[0]!.trusted!
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ ...agentManifest, version: '2.0.0' }))
    await writeFile(path.join(source, 'dist/agent/entry.js'), 'export function activate() { return "new" }')
    await manager.reload('agent')
    const next = manager.acquire()
    assert.equal(next.descriptors[0]!.version, '2.0.0')
    const { readFile } = await import('node:fs/promises')
    assert.match(await readFile(oldPath, 'utf8'), /old/)
    assert.match(await readFile(next.agentEntries[0]!.trusted!, 'utf8'), /new/)
    await lease.release()
    await assert.rejects(readFile(oldPath, 'utf8'))
    await next.release()
  } finally {
    await cleanup()
  }
})

test('外部插件只能依赖插件声明服务，不能取得 Host 内部装配', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    assert.throws(
      () => manager.registerFixture(manifest('external', '1.0.0', [], ['host.workspace']), { create() {} }, directory),
      /内置装配服务/,
    )
    await assert.rejects(
      manager.registerFixture(manifest('external', '1.0.0', [], ['clock']), { create() {} }, directory),
      /所需服务不可用/,
    )
  } finally {
    await cleanup()
  }
})

test('较大浏览器产物打包上传不触发 Base64 正则堆栈溢出', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const source = path.join(directory, 'large')
    await mkdir(path.join(source, 'dist/ui'), { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'large-ui', version: '1.0.0', piMeme: { sdkVersion: 3, ui: 'dist/ui/entry.js' } }),
    )
    await writeFile(
      path.join(source, 'dist/ui/entry.js'),
      `export function activate() {}\n// ${'a'.repeat(2 * 1024 * 1024)}`,
    )
    const installed = await manager.installPackage(await packPlugin(source))
    assert.equal(installed.id, 'large-ui')
  } finally {
    await cleanup()
  }
})

test('一个旧代次释放失败仍释放其余租约，重复释放不会再执行', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const disposed: string[] = []
    const agent = (name: string, version: string): PluginManifest => ({
      name,
      version,
      piMeme: { sdkVersion: 3, agent: { trusted: 'dist/agent/entry.js' } },
    })
    for (const name of ['first', 'second']) {
      await manager.registerFixture(
        agent(name, '1.0.0'),
        {
          create(context) {
            context.onDispose(() => {
              disposed.push(name)
              if (name === 'first') throw new Error('释放失败')
            })
          },
        },
        directory,
      )
    }
    const lease = manager.acquire()
    for (const name of ['first', 'second'])
      await manager.registerFixture(agent(name, '2.0.0'), { create() {} }, directory)
    await assert.rejects(lease.release(), /插件租约释放失败/)
    assert.deepEqual(disposed, ['first', 'second'])
    await lease.release()
    assert.deepEqual(disposed, ['first', 'second'])
  } finally {
    await cleanup()
  }
})

test('外部交互插件保留会话交互代次', async () => {
  const interactionManifest = parsePluginManifest({
    ...manifest('interaction-fixture'),
    piMeme: { ...manifest('interaction-fixture').piMeme, agent: { trusted: 'dist/agent/entry.js' } },
  })
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-interaction-lease-'))
  const manager = new FixtureManager({
    directory: path.join(directory, 'installed'),
    dataDirectory: path.join(directory, 'data'),
    stateFile: path.join(directory, 'state/plugins.json'),
  })
  try {
    const externalManifest = {
      ...interactionManifest,
      name: 'interaction-fixture',
      piMeme: { ...interactionManifest.piMeme, requires: [] },
    }
    await manager.registerFixture(externalManifest, { create() {} }, directory)
    const lease = manager.acquire()
    try {
      assert.ok(lease.retainedIds.includes('interaction-fixture'))
      assert.ok(lease.agentEntries.some((entry) => entry.pluginId === 'interaction-fixture'))
    } finally {
      await lease.release()
    }
  } finally {
    await manager.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('共享交互服务切换时旧租约能回答审批，新调用仍被 gate 拒绝', async () => {
  let onDrain!: () => void
  const draining = new Promise<void>((resolve) => {
    onDrain = resolve
  })
  const { directory, manager, cleanup } = await setup(async () => {
    onDrain()
  })
  let lease: ReturnType<PluginManager['acquire']> | undefined
  let update: Promise<unknown> | undefined
  try {
    const entry = manifest('interaction-fixture')
    entry.piMeme.agent = { trusted: 'dist/agent/entry.js' }
    await manager.registerFixture(
      entry,
      {
        create(context) {
          context.registerOperations([operation('answer', (value) => `旧审批：${String(value)}`, 'string', 'string')])
        },
      },
      directory,
    )
    lease = manager.acquire()
    update = manager.registerFixture({ ...entry, version: '2.0.0' }, { create() {} }, directory)
    await draining
    await assert.rejects(manager.call(entry.name, 'answer', '外部新调用'), /generation-mismatch/)
    assert.throws(() => manager.acquire(), /切换版本/)
    assert.equal(await callLease(lease, entry.name, 'answer', '已持租约的回答'), '旧审批：已持租约的回答')
    const child = manager.acquire(undefined, lease.descriptors)
    assert.equal(await callLease(child, entry.name, 'answer', '子任务旧审批'), '旧审批：子任务旧审批')
    await lease.release()
    assert.equal(manager.list()[0]?.status, 'pending')
    await child.release()
    await update
    await assert.rejects(callLease(lease, entry.name, 'answer', '租约结束后'), /租约已释放/)
  } finally {
    await lease?.release()
    await update?.catch(() => {})
    await cleanup()
  }
})

test('交互组等待旧审批时无关 Git 更新立即完成，后续发布保留 Git 新版本', async () => {
  let onDrain!: () => void
  const draining = new Promise<void>((resolve) => {
    onDrain = resolve
  })
  const { directory, manager, cleanup } = await setup(async () => {
    onDrain()
  })
  let lease: ReturnType<PluginManager['acquire']> | undefined
  let interactionUpdate: Promise<unknown> | undefined
  let gitUpdate: Promise<unknown> | undefined
  try {
    const interaction = manifest('interaction-pending')
    interaction.piMeme.agent = { trusted: 'dist/agent/entry.js' }
    await manager.registerFixture(interaction, { create() {} }, directory)
    await manager.registerFixture(manifest('git-independent'), { create() {} }, directory)
    lease = manager.acquire()
    interactionUpdate = manager.registerFixture({ ...interaction, version: '2.0.0' }, { create() {} }, directory)
    await draining
    await assert.rejects(manager.disable(interaction.name), /依赖组正在切换/)
    gitUpdate = manager.registerFixture(manifest('git-independent', '2.0.0'), { create() {} }, directory)
    await Promise.race([
      gitUpdate,
      delay(1000, undefined, { ref: false }).then(() => {
        throw new Error('无关 Git 更新被待答交互阻塞')
      }),
    ])
    await assert.rejects(callLease(lease, 'outside-lease', 'unknown'), /不属于此租约/)
    await lease.release()
    await Promise.all([interactionUpdate, gitUpdate])
    assert.equal(manager.list().find((entry) => entry.id === 'git-independent')!.version, '2.0.0')
    assert.equal(manager.list().find((entry) => entry.id === interaction.name)!.version, '2.0.0')
  } finally {
    await lease?.release()
    await Promise.allSettled([interactionUpdate, gitUpdate])
    await cleanup()
  }
})

test('交互组新版启动失败只恢复本组，不覆盖排空期间发布的 Git 新版', async () => {
  let onDrain!: () => void
  const draining = new Promise<void>((resolve) => {
    onDrain = resolve
  })
  const { directory, manager, cleanup } = await setup(async () => {
    onDrain()
  })
  let lease: ReturnType<PluginManager['acquire']> | undefined
  let update: Promise<unknown> | undefined
  try {
    const original = manifest('interaction-rollback')
    original.piMeme.agent = { trusted: 'dist/agent/entry.js' }
    await manager.registerFixture(original, { create() {} }, directory)
    await manager.registerFixture(manifest('git-stable'), { create() {} }, directory)
    lease = manager.acquire()
    update = manager.registerFixture(
      { ...original, version: '2.0.0' },
      {
        create() {
          throw new Error('交互新版启动失败')
        },
      },
      directory,
    )
    await draining
    await manager.registerFixture(manifest('git-stable', '2.0.0'), { create() {} }, directory)
    await lease.release()
    await assert.rejects(update, /交互新版启动失败/)
    assert.equal(manager.list().find((entry) => entry.id === 'git-stable')!.version, '2.0.0')
    assert.equal(manager.list().find((entry) => entry.id === original.name)!.version, '1.0.0')
    const saved = JSON.parse(await readFile(path.join(directory, 'state/plugins.json'), 'utf8')).records as Array<{
      id: string
      enabled: boolean
    }>
    assert.ok(saved.find((entry) => entry.id === 'git-stable')!.enabled)
    assert.ok(saved.find((entry) => entry.id === original.name)!.enabled)
  } finally {
    await lease?.release()
    await update?.catch(() => {})
    await cleanup()
  }
})

test('跨重启恢复不复用代次，旧clean UI请求和旧编辑租约不能落入新版Server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-generation-restart-'))
  const options = {
    directory: path.join(root, 'installed'),
    dataDirectory: path.join(root, 'data'),
    stateFile: path.join(root, 'state/plugins.json'),
  }
  const source = path.join(root, 'source')
  const managers: PluginManager[] = []
  const create = () => {
    const manager = new PluginManager(options)
    managers.push(manager)
    return manager
  }
  const build = async (version: string, label: string) => {
    await mkdir(path.join(source, 'dist/ui'), { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest('restart-audit', version)))
    await writeFile(path.join(source, 'dist/ui/entry.js'), 'export function activate() {}')
    await writeFile(
      path.join(source, 'entry.ts'),
      `import { defineFacet, defineService } from '@earendil-works/chord'
export default defineFacet({id:'restart-module',setup(env){env.provide(defineService('pi-meme.plugin.module:restart-audit',{local:true}),{create(context){context.registerOperations([{name:'inspect',inputSchema:{type:'null'},outputSchema:{type:'string'},audience:['ui'],effect:'read',capabilities:[],execute:()=>${JSON.stringify(label)}}])}})}})`,
    )
    await bundleFacets({
      plugin: { id: 'restart-audit', version },
      entries: { server: path.join(source, 'entry.ts') },
      outdir: path.join(source, 'dist/server'),
    })
  }
  try {
    await build('1.0.0', 'V1')
    const bootstrap = create()
    await bootstrap.loadDirectory(source)
    await trustInstalled(bootstrap, 'restart-audit')
    await bootstrap.dispose()
    const first = create()
    await first.restore()
    const old = first.list()[0]!
    const request = {
      pluginId: old.id,
      generation: old.generation,
      policyHash: old.policyHash!,
      operation: 'inspect',
      input: null,
      requestId: crypto.randomUUID(),
    }
    const context = callContext(old.id, old.generation, 'ui')
    assert.equal(await first.callUi('fixture', request, context), 'V1')
    const lease = first.acquireUiLease('fixture', {
      pluginId: old.id,
      generation: old.generation,
      routeInstance: 'old-route',
    })
    await first.releaseUiLease('fixture', lease.id)
    await build('2.0.0', 'V2')
    await first.loadDirectory(source)
    await trustInstalled(first, old.id)
    const updated = first.list()[0]!
    await first.dispose()
    const second = create()
    await second.restore()
    const current = second.list()[0]!
    assert.notEqual(current.policyHash, old.policyHash)
    await assert.rejects(second.callUi('fixture', request, context), /generation-mismatch|policy-changed/)
    await assert.rejects(second.callUi('fixture', { ...request, leaseId: lease.id }, context), /scope-expired/)
    assert.ok(current.generation > updated.generation)
    const currentRequest = { ...request, generation: current.generation, policyHash: current.policyHash! }
    assert.equal(await second.callUi('fixture', currentRequest, callContext(old.id, current.generation, 'ui')), 'V2')
    await assert.rejects(
      second.callUi(
        'fixture',
        { ...currentRequest, policyHash: old.policyHash! },
        callContext(old.id, current.generation, 'ui'),
      ),
      /policy-changed/,
    )
    await assert.rejects(
      second.callUi(
        'fixture',
        { ...currentRequest, policyHash: undefined } as unknown as typeof currentRequest,
        callContext(old.id, current.generation, 'ui'),
      ),
      /policy-changed/,
    )
  } finally {
    for (const manager of managers.reverse()) await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('代次预留失败不排空或释放旧服务与活租约，失败号码不再使用', async () => {
  let drained = 0
  let disposed = 0
  let checkingReservation = true
  const { directory, manager, cleanup } = await setup(async () => {
    if (checkingReservation) {
      drained++
      throw new Error('预留失败不应排空旧租约')
    }
  })
  let lease: PluginLease | undefined
  let update: Promise<unknown> | undefined
  try {
    const entry = manifest('durable-reservation')
    entry.piMeme.agent = { trusted: 'dist/agent/entry.js' }
    await manager.registerFixture(
      entry,
      {
        create(context) {
          context.registerOperations([operation('read', () => 'old')])
          context.onDispose(() => {
            disposed++
          })
        },
      },
      directory,
    )
    const state = path.join(directory, 'state/plugins.json')
    const original = await readFile(state, 'utf8')
    const high = JSON.parse(original).generationHighWaterMark as number
    lease = manager.acquire()
    await rm(state)
    await mkdir(state)
    update = manager.registerFixture({ ...entry, version: '2.0.0' }, { create() {} }, directory)
    await assert.rejects(update)
    assert.equal(drained, 0)
    checkingReservation = false
    assert.equal(disposed, 0)
    assert.equal(await callLease(lease, entry.name, 'read'), 'old')
    await rm(state, { recursive: true })
    await writeFile(state, original)
    await lease.release()
    lease = undefined
    const next = await manager.registerFixture({ ...entry, version: '2.0.0' }, { create() {} }, directory)
    assert.ok(next.generation > high + 2)
    assert.ok(JSON.parse(await readFile(state, 'utf8')).generationHighWaterMark >= next.generation)
  } finally {
    checkingReservation = false
    await lease?.release()
    await update?.catch(() => {})
    await cleanup()
  }
})

test('同代码重新激活和失败回滚都分配新代次，高水位不回退', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const entry = manifest('durable-rollback')
    const module = {
      create(context: Parameters<ServerPluginModule['create']>[0]) {
        context.registerOperations([operation('read', () => 'old')])
      },
    }
    const first = await manager.registerFixture(entry, module, directory)
    const reloaded = await manager.registerFixture(entry, module, directory)
    assert.equal(first.policyHash, reloaded.policyHash)
    assert.ok(reloaded.generation > first.generation)
    const state = path.join(directory, 'state/plugins.json')
    const before = JSON.parse(await readFile(state, 'utf8')).generationHighWaterMark
    await assert.rejects(
      manager.registerFixture(
        { ...entry, version: '2.0.0' },
        {
          create() {
            throw new Error('candidate failed')
          },
        },
        directory,
      ),
      /candidate failed/,
    )
    const restored = manager.list()[0]!
    const saved = JSON.parse(await readFile(state, 'utf8'))
    assert.ok(restored.generation > reloaded.generation)
    assert.ok(saved.generationHighWaterMark > before)
    assert.equal(saved.records[0].directory, directory)
    assert.equal(await manager.call(entry.name, 'read'), 'old')
  } finally {
    await cleanup()
  }
})

test.each([
  '{bad-json',
  JSON.stringify({ format: 'pi-meme-plugins', version: 99, generationHighWaterMark: 1, records: [] }),
  JSON.stringify({
    format: 'pi-meme-plugins',
    version: 1,
    generationHighWaterMark: Number.MAX_SAFE_INTEGER + 1,
    records: [],
  }),
])('损坏或未知代次清单原文件保留且拒绝激活：%s', async (contents) => {
  const { directory, manager, cleanup } = await setup()
  try {
    await mkdir(path.join(directory, 'installed'), { recursive: true })
    const state = path.join(directory, 'state/plugins.json')
    await writeFile(state, contents)
    await manager.restore()
    assert.deepEqual(manager.list(), [])
    assert.ok(manager.diagnostics().length)
    await assert.rejects(manager.registerFixture(manifest('blocked'), { create() {} }, directory), /清单读取失败/)
    assert.equal(await readFile(state, 'utf8'), contents)
  } finally {
    await cleanup()
  }
})

test('代次溢出恢复不激活任何候选，不重写原记录', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const source = path.join(directory, 'source')
    await mkdir(path.join(source, 'dist/ui'), { recursive: true })
    await writeFile(path.join(source, 'dist/ui/entry.js'), 'export function activate() {}')
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'overflow', version: '1.0.0', piMeme: { sdkVersion: 3, ui: 'dist/ui/entry.js' } }),
    )
    await mkdir(path.join(directory, 'installed'))
    const state = path.join(directory, 'state/plugins.json')
    const contents = JSON.stringify({
      format: 'pi-meme-plugins',
      version: 1,
      generationHighWaterMark: Number.MAX_SAFE_INTEGER,
      records: [{ id: 'overflow', directory: source, enabled: true }],
    })
    await writeFile(state, contents)
    await manager.restore()
    assert.deepEqual(manager.list(), [])
    assert.match(manager.diagnostics()[0]!.message, /溢出/)
    assert.equal(await readFile(state, 'utf8'), contents)
  } finally {
    await cleanup()
  }
})

test('共享Publisher在同代码Server重建后恢复CAS修订，快照与命名空间保持隔离', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const publishers: SharedDataPublisher[] = []
    const module: ServerPluginModule = {
      create(context) {
        publishers.push(context.sharedData)
      },
    }
    const entry = manifest('shared-owner')
    const before = await manager.registerFixture(entry, module, directory)
    await publishers[0]!.publish('catalog', { entries: ['global'] }, { expectedRevision: 0 })
    await publishers[0]!.publish('catalog', { entries: ['project'] }, { scope: 'project-a', expectedRevision: 0 })
    const after = await trustInstalled(manager, entry.name)
    assert.equal(after.policyHash, before.policyHash)
    assert.notEqual(after.generation, before.generation)
    assert.equal(publishers.length, 2)
    const publisher = publishers[1]!
    const snapshot = await publisher.getSnapshot('catalog')
    assert.deepEqual(snapshot, { value: { entries: ['global'] }, revision: 1 })
    assert.ok(snapshot)
    const value = snapshot.value as { entries: string[] }
    value.entries.push('不得写回')
    snapshot.revision = 99
    assert.deepEqual(await publisher.getSnapshot('catalog', { scope: '' }), {
      value: { entries: ['global'] },
      revision: 1,
    })
    await assert.rejects(
      publisher.publish('catalog', { entries: ['stale'] }, { expectedRevision: 0 }),
      /policy-changed: 共享数据修订冲突/,
    )
    const recovered = await publisher.getSnapshot('catalog')
    assert.ok(recovered)
    assert.deepEqual(
      await publisher.publish('catalog', { entries: ['updated'] }, { expectedRevision: recovered.revision }),
      { value: { entries: ['updated'] }, revision: 2 },
    )
    assert.equal(await publisher.getSnapshot('empty'), undefined)
    assert.equal(await publisher.getSnapshot('catalog', { scope: 'project-b' }), undefined)
    assert.deepEqual(await publisher.getSnapshot('catalog', { scope: 'project-a' }), {
      value: { entries: ['project'] },
      revision: 1,
    })
    for (const key of ['', '../catalog', 'other/catalog', 'catalog name']) {
      await assert.rejects(publisher.getSnapshot(key), /invalid-input: 共享数据名称无效/)
      await assert.rejects(publisher.publish(key, null, { expectedRevision: 0 }), /invalid-input: 共享数据名称无效/)
    }
    await manager.registerFixture(manifest('other-publisher'), module, directory)
    const other = publishers[2]!
    assert.equal(await other.getSnapshot('catalog'), undefined)
    assert.equal(await other.getSnapshot('catalog', { scope: 'project-a' }), undefined)
    await other.publish('catalog', { entries: ['other'] }, { expectedRevision: 0 })
    assert.deepEqual(await publisher.getSnapshot('catalog'), { value: { entries: ['updated'] }, revision: 2 })
  } finally {
    await cleanup()
  }
})

test('legacy数组只迁移envelope，保留SDK2与未知record字段原样且不执行', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const source = path.join(directory, 'legacy')
    await mkdir(source)
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'legacy-preserved', version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'entry.js' } }),
    )
    await writeFile(path.join(source, 'entry.js'), 'throw new Error("不得执行旧代码")')
    const sdk3 = path.join(directory, 'disabled-ui')
    await mkdir(path.join(sdk3, 'dist/ui'), { recursive: true })
    await writeFile(
      path.join(sdk3, 'package.json'),
      JSON.stringify({ name: 'disabled-ui', version: '1.0.0', piMeme: { sdkVersion: 3, ui: 'dist/ui/entry.js' } }),
    )
    await writeFile(path.join(sdk3, 'dist/ui/entry.js'), 'export function activate() {}')
    const records = [
      {
        id: 'legacy-preserved',
        directory: source,
        enabled: true,
        builtin: false,
        customMetadata: { preserve: ['all', 'fields'] },
      },
      { id: 'disabled-ui', directory: sdk3, enabled: false, customMetadata: { preserve: ['sdk3'] } },
    ]
    await mkdir(path.join(directory, 'installed'))
    const state = path.join(directory, 'state/plugins.json')
    await writeFile(state, JSON.stringify(records))
    await manager.restore()
    const saved = JSON.parse(await readFile(state, 'utf8'))
    assert.deepEqual(saved.records, records)
    assert.equal(saved.generationHighWaterMark, 0)
    assert.match(manager.diagnostics()[0]!.message, /unsupported-sdk/)
    assert.equal(manager.list().find((item) => item.id === 'legacy-preserved')!.status, 'failed')
    assert.equal(manager.list().find((item) => item.id === 'disabled-ui')!.status, 'disabled')
  } finally {
    await cleanup()
  }
})
