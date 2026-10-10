import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { McpConfigStore } from '../src/server/config-store'
import { serverError } from '../src/shared/config'

test('新增、改名、禁用和删除单个服务，保留未知字段及其他服务', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-config-'))
  const file = path.join(directory, 'mcp.json')
  const credentials = new MemoryCredentialStorage()
  const store = new McpConfigStore(file, credentials)
  try {
    await writeFile(
      file,
      JSON.stringify({
        autoEnableCodemode: false,
        custom: { value: 1 },
        mcpServers: { keep: { command: 'keep', extra: true, oauth: { clientSecret: 'legacy-secret' } } },
      }),
    )
    let snapshot = await store.snapshot()
    snapshot = await store.save({
      revision: snapshot.revision,
      name: 'docs',
      config: { url: 'http://localhost/mcp', oauth: { clientId: 'client', clientSecret: 'new-secret' }, custom: 2 },
    })
    snapshot = await store.save({
      revision: snapshot.revision,
      name: 'renamed',
      previousName: 'docs',
      config: { ...(snapshot.servers[1].config as object), enabled: false },
    })
    const data = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(data.mcpServers.renamed.oauth.clientId, 'client')
    assert.equal(data.mcpServers.renamed.oauth.clientSecret, undefined)
    assert.equal(data.mcpServers.keep.oauth.clientSecret, undefined)
    assert.equal(credentials.get('mcp-oauth-client:docs'), undefined)
    assert.equal(credentials.get('mcp-oauth-client:renamed'), 'new-secret')
    assert.ok(!JSON.stringify(data).includes('new-secret'))
    assert.ok(!JSON.stringify(data).includes('legacy-secret'))
    assert.equal(data.mcpServers.renamed.custom, 2)
    assert.equal(data.mcpServers.renamed.enabled, false)
    assert.equal(data.mcpServers.keep.extra, true)
    assert.equal(data.autoEnableCodemode, false)
    assert.deepEqual(data.custom, { value: 1 })
    assert.equal(data.mcpServers.docs, undefined)
    snapshot = await store.delete({ revision: snapshot.revision, name: 'renamed' })
    assert.equal(credentials.get('mcp-oauth-client:renamed'), undefined)
    assert.deepEqual(
      snapshot.servers.map((entry) => entry.name),
      ['keep'],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('缺失文件可创建；外部修改、空文件和损坏文件不能覆盖；无效服务可读取并修复', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-conflict-'))
  const file = path.join(directory, 'mcp.json')
  const store = new McpConfigStore(file)
  try {
    const missing = await store.snapshot()
    assert.equal(missing.error, undefined)
    await writeFile(file, '')
    await assert.rejects(store.save({ revision: missing.revision, name: 'new', config: { command: 'node' } }), /损坏/)
    assert.equal(await readFile(file, 'utf8'), '')
    await rm(file)
    let snapshot = await store.save({ revision: missing.revision, name: 'new', config: { command: 'node' } })
    await writeFile(file, '{"mcpServers":{"new":{"command":"changed"}}}')
    await assert.rejects(store.delete({ revision: snapshot.revision, name: 'new' }), /其他程序修改/)
    assert.match(await readFile(file, 'utf8'), /changed/)
    await writeFile(file, '{"mcpServers":{"bad":{"url":5}}}')
    snapshot = await store.snapshot()
    assert.ok(snapshot.servers[0].error)
    snapshot = await store.save({
      revision: snapshot.revision,
      name: 'bad',
      previousName: 'bad',
      config: { url: 'https://example.com/mcp' },
    })
    assert.equal(snapshot.servers[0].error, undefined)
    await writeFile(file, '{broken')
    snapshot = await store.snapshot()
    assert.ok(snapshot.error)
    await assert.rejects(store.delete({ revision: snapshot.revision, name: 'bad' }), /损坏/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('校验本地命令、HTTP、OAuth 和工具暴露方式，并拒绝命名空间碰撞', async () => {
  assert.ok(serverError('bad.name', { command: 'node' }))
  assert.ok(serverError('test', { command: 'node', args: [1] }))
  assert.ok(serverError('test', { url: 'file:///tmp/mcp' }))
  assert.ok(serverError('test', { url: 'https://example.com', oauth: { callbackPort: 0 } }))
  assert.ok(serverError('test', { url: 'https://example.com', oauth: { callbackUrl: 'https://elsewhere/callback' } }))
  assert.equal(
    serverError('test', {
      url: 'https://example.com',
      exposure: 'deferred',
      toolExposure: { '*': 'direct' },
      oauth: { authServerMetadataUrl: 'https://example.com/metadata' },
      future: true,
    }),
    undefined,
  )
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-names-'))
  const store = new McpConfigStore(path.join(directory, 'mcp.json'))
  try {
    const first = await store.save({
      revision: (await store.snapshot()).revision,
      name: 'a-b',
      config: { command: 'node' },
    })
    await assert.rejects(
      store.save({ revision: first.revision, name: 'a_b', config: { command: 'node' } }),
      /命名空间冲突/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
