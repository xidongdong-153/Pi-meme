import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import type { SaveModelProvider } from '@pi-meme/contracts/model-config'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { ModelConfigStore } from '../src/server/config-store'
import { ModelService } from '../src/server/model-service'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-model-service-'))
  const agentDir = path.join(root, 'config/agent')
  await mkdir(agentDir, { recursive: true })
  const credentials = new MemoryCredentialStorage()
  const models = new ModelConfigStore(path.join(agentDir, 'models.json'), credentials)
  const state = { busy: false, failReconnect: false, reconnects: 0, selected: { provider: 'local', id: 'model' } }
  const pi = {
    idle: async <T>(work: () => Promise<T>) => {
      if (state.busy) throw new Error('有会话正在运行')
      return work()
    },
    connection: () => ({ status: 'ready' }),
    captureRestoreState: async () => ({ model: { ...state.selected } }),
    reconnectModels: async (restore: { model: typeof state.selected }) => {
      state.reconnects++
      if (state.failReconnect) throw new Error('重连失败 fixture-private-key')
      state.selected = restore.model
    },
    snapshot: async () => {
      throw new Error('模型目录不得读取当前会话')
    },
  } as unknown as PiRuntime
  return {
    state,
    models,
    credentials,
    service: new ModelService(pi, models),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

function provider(revision: string): SaveModelProvider {
  return {
    revision,
    provider: {
      id: 'gateway',
      name: '模型网关',
      api: 'openai-completions',
      baseUrl: 'http://localhost:9/v1',
      models: [{ id: 'upstream/model' }],
    },
    apiKey: 'fixture-private-key',
  }
}

test('繁忙时普通提供商注入不写配置和凭据，空闲后使用同一保存入口', async () => {
  const f = await fixture()
  try {
    const revision = (await f.models.snapshot()).revision
    f.state.busy = true
    await assert.rejects(
      f.service.changeModels(() => f.models.save(provider(revision))),
      /正在运行/,
    )
    assert.equal((await f.models.snapshot()).revision, revision)
    assert.deepEqual(f.credentials.entries(), [])
    f.state.busy = false
    const saved = await f.service.changeModels(() => f.models.save(provider(revision)))
    assert.equal(saved.reconnectError, undefined)
    assert.equal(saved.snapshot.providers[0].id, 'gateway')
    assert.deepEqual(f.state.selected, { provider: 'local', id: 'model' })
    const catalog = await f.service.list()
    assert.ok(catalog.some((model) => model.provider === 'gateway' && model.id === 'upstream/model'))
    for (const secret of ['fixture-private-key', 'baseUrl', 'headers', 'credential'])
      assert.ok(!JSON.stringify(catalog).includes(secret))
    assert.ok(!(await readFile(f.models.filePath, 'utf8')).includes('fixture-private-key'))
  } finally {
    await f.dispose()
  }
})

test('提供商已保存但重连失败时返回可恢复结果，错误不包含内部凭据', async () => {
  const f = await fixture()
  try {
    f.state.failReconnect = true
    const input = provider((await f.models.snapshot()).revision)
    const saved = await f.service.changeModels(() => f.models.save(input))
    assert.ok(saved.reconnectError)
    assert.ok(!saved.reconnectError.includes('fixture-private-key'))
    assert.equal((await f.models.snapshot()).providers[0].id, 'gateway')
    f.state.failReconnect = false
    await f.service.reconnect()
    assert.equal(f.state.reconnects, 2)
    assert.deepEqual(f.state.selected, { provider: 'local', id: 'model' })
  } finally {
    await f.dispose()
  }
})
