import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { PluginManager, type PluginDescriptor, type PluginLease } from '../src/manager'
import { assertExternalManifest } from '@pi-meme/plugin-sdk/reserved'
import type { ServerPluginModule, PluginHandlers } from '@pi-meme/plugin-sdk/server'
import { bundleFacets } from '@earendil-works/chord/bundler'
import { packPlugin, unpackPlugin } from '../src/package'
import type { PluginManifest } from '@pi-meme/plugin-sdk/manifest'
import { parsePluginManifest } from '@pi-meme/plugin-sdk/manifest'

// 旧生命周期断言使用内存 external fixture，生产安装入口另行验收。
class FixtureManager extends PluginManager {
  private aliases = new Map<string, string>()
  registerFixture(manifest: PluginManifest, module: ServerPluginModule, directory: string) {
    assertExternalManifest(manifest)
    const wrapped: ServerPluginModule = {
      create: (context) =>
        module.create(
          Object.assign(Object.create(context), {
            registerHandlers: (handlers: PluginHandlers) => {
              const namespaced: PluginHandlers = {}
              for (const [channel, handler] of Object.entries(handlers)) {
                const name = channel.startsWith(`${manifest.name}:`) ? channel : `${manifest.name}:${channel}`
                this.aliases.set(channel, name)
                namespaced[name] = handler
              }
              return context.registerHandlers(namespaced)
            },
          }),
        ),
    }
    return (
      this as unknown as {
        replace: (registration: {
          manifest: PluginManifest
          module: ServerPluginModule
          directory: string
          enabled: boolean
        }) => Promise<PluginDescriptor>
      }
    ).replace({ manifest, module: wrapped, directory, enabled: true })
  }
  override handlers() {
    const handlers = super.handlers()
    for (const [alias, name] of this.aliases) {
      if (handlers[name] && alias !== name) {
        handlers[alias] = handlers[name]!
        delete handlers[name]
      }
    }
    return handlers
  }
  override acquire(
    isEnabled?: (pluginId: string) => boolean,
    from?: ReadonlyArray<{ id: string; generation: number }>,
  ): PluginLease {
    const lease = super.acquire(isEnabled, from)
    return { ...lease, runHandler: (channel, args) => lease.runHandler(this.aliases.get(channel) ?? channel, args) }
  }
}

function manifest(name: string, version = '1.0.0', provides: string[] = [], requires: string[] = []): PluginManifest {
  return {
    name,
    version,
    piMeme: { sdkVersion: 2, server: 'dist/server/chord-facets.json', provides, requires },
  }
}

async function setup(drain?: (pluginIds: string[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-plugins-'))
  const manager = new FixtureManager({
    directory: path.join(directory, 'installed'),
    dataDirectory: path.join(directory, 'data'),
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
      { ...manifest('clock'), piMeme: { ...manifest('clock').piMeme, agent: 'dist/agent/entry.js' } },
      {
        create: (context) => {
          context.registerHandlers({ time: () => 'old' })
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
            context.registerHandlers({ time: () => 'new' })
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
    assert.equal(await manager.handlers().time!(), 'new')
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
    assert.equal(await manager.handlers().time!(), 'new')
    await manager.disable('clock')
    assert.deepEqual(manager.handlers(), {})
    await manager.enable('clock')
    assert.equal(await manager.handlers().time!(), 'new')
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
          context.registerHandlers({ now: () => clock.now() })
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
    assert.equal(await manager.handlers().now!(), 2)
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
    await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest('external')))
    await writeFile(path.join(source, '.env'), 'FAKE_SECRET=test-only')
    await writeFile(path.join(source, 'secret.pem'), 'test-only-private-key')
    await writeFile(
      path.join(source, 'entry.ts'),
      `import { defineFacet, defineService } from '@earendil-works/chord'
export default defineFacet({ id:'external-module', setup(env) { env.provide(defineService('pi-meme.plugin.module:external', {local:true}), {
  create(ctx) { ctx.registerHandlers({ 'external:time': () => 'ok' }) }
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
    assert.equal(await manager.handlers()['external:time']!(), 'ok')
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
      piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' },
    }
    await manager.registerFixture(agentManifest, { create() {} }, directory)
    const oldLease = manager.acquire()
    const oldGeneration = oldLease.agentEntries[0]!.generation
    await manager.registerFixture({ ...agentManifest, version: '2.0.0' }, { create() {} }, directory)
    const newLease = manager.acquire()
    assert.notEqual(newLease.agentEntries[0]!.generation, oldGeneration)
    assert.equal(manager.getGeneration('agent', oldGeneration)?.version, '1.0.0')
    assert.equal(oldLease.descriptors[0]!.version, '1.0.0')
    await manager.registerFixture(
      manifest('git'),
      {
        create: (context) => {
          context.registerHandlers({ diff: () => 1 })
        },
      },
      directory,
    )
    await manager.registerFixture(
      manifest('git', '2.0.0'),
      {
        create: (context) => {
          context.registerHandlers({ diff: () => 2 })
        },
      },
      directory,
    )
    assert.equal(await manager.runHandler('diff'), 2)
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
      piMeme: { sdkVersion: 2, ui: 'dist/ui/entry.js' },
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
          context.registerHandlers({ now: () => clock.now() })
          context.onDispose(() => {
            order.push('consumer')
          })
        },
      },
      directory,
    )
    order.length = 0
    const state = path.join(directory, 'installed/installed.json')
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
    assert.equal(await manager.runHandler('now'), 1)
    assert.deepEqual(order, [])
    await rm(state, { recursive: true })
    await manager.disable('consumer')
    assert.deepEqual(order, ['consumer', 'provider'])
  } finally {
    await cleanup()
  }
})

test('目录重新构建后 reload 取新版，旧 Agent 租约仍读取旧快照', async () => {
  const { directory, manager, cleanup } = await setup()
  try {
    const source = path.join(directory, 'source')
    await mkdir(path.join(source, 'dist/agent'), { recursive: true })
    const agentManifest: PluginManifest = {
      name: 'agent',
      version: '1.0.0',
      piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' },
    }
    await writeFile(path.join(source, 'package.json'), JSON.stringify(agentManifest))
    await writeFile(path.join(source, 'dist/agent/entry.js'), 'export function activate() { return "old" }')
    await manager.loadDirectory(source)
    const lease = manager.acquire()
    const oldPath = lease.agentEntries[0]!.path
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ ...agentManifest, version: '2.0.0' }))
    await writeFile(path.join(source, 'dist/agent/entry.js'), 'export function activate() { return "new" }')
    await manager.reload('agent')
    const next = manager.acquire()
    assert.equal(next.descriptors[0]!.version, '2.0.0')
    const { readFile } = await import('node:fs/promises')
    assert.match(await readFile(oldPath, 'utf8'), /old/)
    assert.match(await readFile(next.agentEntries[0]!.path, 'utf8'), /new/)
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
      JSON.stringify({ name: 'large-ui', version: '1.0.0', piMeme: { sdkVersion: 2, ui: 'dist/ui/entry.js' } }),
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
      piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' },
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
  const interactionManifest = parsePluginManifest(
    JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../interaction/package.json'), 'utf8')),
  )
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-meme-interaction-lease-'))
  const manager = new FixtureManager({
    directory: path.join(directory, 'installed'),
    dataDirectory: path.join(directory, 'data'),
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
    entry.piMeme.agent = 'dist/agent/entry.js'
    await manager.registerFixture(
      entry,
      {
        create(context) {
          context.registerHandlers({ answer: (value) => `旧审批：${String(value)}` })
        },
      },
      directory,
    )
    lease = manager.acquire()
    update = manager.disable(entry.name)
    await draining
    await assert.rejects(manager.runHandler('answer', ['外部新调用']), /切换版本/)
    assert.throws(() => manager.acquire(), /切换版本/)
    assert.equal(await lease.runHandler('answer', ['已持租约的回答']), '旧审批：已持租约的回答')
    const child = manager.acquire(undefined, lease.descriptors)
    assert.equal(await child.runHandler('answer', ['子任务旧审批']), '旧审批：子任务旧审批')
    await lease.release()
    assert.equal(manager.list()[0]?.status, 'pending')
    await child.release()
    await update
    await assert.rejects(lease.runHandler('answer', ['租约结束后']), /租约已释放/)
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
    interaction.piMeme.agent = 'dist/agent/entry.js'
    await manager.registerFixture(interaction, { create() {} }, directory)
    await manager.registerFixture(manifest('git-independent'), { create() {} }, directory)
    lease = manager.acquire()
    interactionUpdate = manager.disable(interaction.name)
    await draining
    await assert.rejects(manager.disable(interaction.name), /依赖组正在切换/)
    gitUpdate = manager.registerFixture(manifest('git-independent', '2.0.0'), { create() {} }, directory)
    await Promise.race([
      gitUpdate,
      delay(1000, undefined, { ref: false }).then(() => {
        throw new Error('无关 Git 更新被待答交互阻塞')
      }),
    ])
    await assert.rejects(lease.runHandler('未租用操作'), /租约不包含/)
    await lease.release()
    await Promise.all([interactionUpdate, gitUpdate])
    assert.equal(manager.list().find((entry) => entry.id === 'git-independent')!.version, '2.0.0')
    assert.equal(manager.list().find((entry) => entry.id === interaction.name)!.enabled, false)
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
    original.piMeme.agent = 'dist/agent/entry.js'
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
    const saved = JSON.parse(await readFile(path.join(directory, 'installed/installed.json'), 'utf8')) as Array<{
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
