import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkerSession } from '../src/worker-session'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'

test('Worker使用稳定SDK懒启动会话，停止后可重新创建运行时', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-worker-test-'))
  const paths = createPiRuntimePaths(root)
  await mkdir(paths.agentDir, { recursive: true })
  const session = createWorkerSession(root, { connection: () => {}, event: () => {}, error: () => {} }, paths, () => ({
    dataRoot: root,
    credentials: new MemoryCredentialStorage(),
    settings: { themeId: 'dark' },
    agentEntries: [],
  }))
  try {
    assert.equal(session.connection().status, 'disconnected')
    session.configureAccess('full-access')
    await session.reconnectModels()
    const snapshot = await session.snapshot()
    assert.equal(snapshot.connection.status, 'ready')
    assert.equal(snapshot.messages.length, 0)
    assert.equal(snapshot.connection.piVersion, '1.1.0')
    await session.stopAndWait()
    assert.equal(session.connection().status, 'disconnected')
    await session.reconnectModels()
    assert.equal((await session.snapshot()).connection.status, 'ready')
  } finally {
    await session.stopAndWait()
    await rm(root, { recursive: true, force: true })
  }
})

test('仓库外原生 Agent 插件通过 Pi 公开模块加载，缺权限能力时受限执行拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-native-plugin-test-'))
  const paths = createPiRuntimePaths(root)
  const entry = path.join(root, 'external', 'entry.js')
  await mkdir(path.dirname(entry), { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    entry,
    `import { SessionManager } from '@earendil-works/pi-coding-agent'\nexport default (pi) => { if (typeof SessionManager.create !== 'function') throw new Error('SDK导入失败'); pi.registerCommand('external-worker', { description: '外部插件命令', handler: async () => {} }) }\n`,
  )
  const session = createWorkerSession(root, { connection: () => {}, event: () => {}, error: () => {} }, paths, () => ({
    dataRoot: root,
    credentials: new MemoryCredentialStorage(),
    settings: { themeId: 'dark' },
    agentEntries: [{ pluginId: 'external-agent', generation: 1, path: entry }],
    descriptors: [{ id: 'external-agent', enabled: true, builtin: false }],
  }))
  try {
    session.configureAccess('full-access')
    await session.reconnectModels()
    assert.ok((await session.getCommands()).some((command) => command.name === 'external-worker'))
    await session.stopAndWait()
    session.configureAccess('workspace-write')
    await assert.rejects(session.reconnectModels(), /权限|沙箱/)
  } finally {
    await session.stopAndWait()
    await rm(root, { recursive: true, force: true })
  }
})
