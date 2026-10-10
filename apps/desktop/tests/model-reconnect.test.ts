import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { ModelConfigStore } from '@pi-meme/models/server/config-store'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { requestText, startFakeProvider } from '../../../tests/fixtures/fake-provider.mjs'

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待会话状态超时')
    await delay(10)
  }
}

function providerConfig(baseUrl: string, models: string[]) {
  return {
    providers: {
      'test-service': {
        name: '测试服务',
        api: 'openai-completions',
        baseUrl,
        apiKey: 'test',
        models: models.map((id) => ({ id, name: `模型 ${id}`, reasoning: true })),
      },
      fake: {
        name: '备用服务',
        api: 'openai-completions',
        baseUrl,
        apiKey: 'test',
        models: [{ id: 'second', name: '模型 second', reasoning: true }],
      },
    },
  }
}

test('模型配置重连恢复会话状态；扩展加载错误不丢失会话且修复后清除', async () => {
  const provider = await startFakeProvider({
    reply: (body) => {
      const text = requestText(body)
      if (text.includes('slow')) return { text: '稍后回复', delayMs: 800 }
      if (text.includes('long-conversation'))
        return Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段内容。`).join('\n\n')
      return '收到'
    },
  })
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-desktop-model-reconnect-'))
  const runtimePaths = createPiRuntimePaths(path.join(cwd, 'userData'))
  const agentDir = runtimePaths.agentDir
  const credentials = new MemoryCredentialStorage()
  await mkdir(agentDir, { recursive: true })
  const initialConfig = providerConfig(provider.baseUrl, ['custom'])
  const providers = Object.fromEntries(
    Object.entries(initialConfig.providers).map(([providerId, config]) => {
      const { apiKey, ...safeConfig } = config
      credentials.set(`model-provider:${providerId}`, JSON.stringify({ credential: { type: 'api_key', key: apiKey } }))
      return [providerId, safeConfig]
    }),
  )
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers }))
  const store = new ModelConfigStore(path.join(agentDir, 'models.json'), credentials, agentDir)
  const errors: string[] = []
  const pool = new PiSessionPool(
    cwd,
    {
      connection: () => {},
      event: () => {},
      error: (value) => errors.push(value.message),
      sessionsChanged: () => {},
    },
    undefined,
    runtimePaths,
    credentials,
  )
  const running = () => pool.getRuntimeSessions().some((session) => session.running)
  try {
    await pool.configureWorkspaces({ kind: () => 'project', createStandaloneDirectory: async () => cwd })
    pool.start(cwd)
    await pool.snapshot()
    await pool.reconnectModels()
    assert.deepEqual(
      (await pool.snapshot()).models.map((model) => `${model.provider}/${model.id}`),
      ['test-service/custom', 'fake/second'],
    )
    const key = pool.connection().sessionKey!
    await pool.setModel(key, { provider: 'test-service', id: 'custom' })
    await pool.setThinkingLevel(key, 'high')
    await pool.prompt(key, 'long-conversation')
    await waitFor(() => !running())
    const before = await pool.snapshot()
    assert.equal(before.state.model?.id, 'custom')
    const beforePath = pool.getActiveSession().sessionFile
    assert.ok(beforePath, '会话应已写入文件')

    // 新增模型后重连：列表刷新，会话文件、模型、思考等级与消息都保持
    await pool.idle(async () => {
      const restore = await pool.captureRestoreState()
      const value = await store.snapshot()
      await store.save({
        revision: value.revision,
        originalId: 'test-service',
        provider: {
          id: 'test-service',
          name: '测试服务',
          api: 'openai-completions',
          baseUrl: provider.baseUrl,
          models: [
            { id: 'custom', name: '模型 custom', reasoning: true },
            { id: 'added', name: '模型 added', reasoning: true },
          ],
        },
      })
      await pool.reconnectModels(restore)
    })
    const after = await pool.snapshot()
    assert.ok(after.models.some((model) => model.id === 'added'))
    assert.equal(after.state.model?.id, 'custom')
    assert.equal(after.state.thinkingLevel, 'high')
    assert.deepEqual(
      after.messages.map((message) => message.role),
      before.messages.map((message) => message.role),
    )
    assert.equal(pool.getActiveSession().sessionFile, beforePath)

    // 删除服务商后重连：进入重新选择模型状态并拦截提示
    await pool.idle(async () => {
      const restore = await pool.captureRestoreState()
      const value = await store.snapshot()
      await store.delete('test-service', value.revision)
      await pool.reconnectModels(restore)
    })
    assert.equal((await pool.snapshot()).state.modelSelectionRequired, true)
    await assert.rejects(pool.prompt(key, '不应发送'), /先重新选择模型/)
    assert.ok(errors.some((message) => message.includes('重新选择模型')))
    await pool.setModel(key, { provider: 'fake', id: 'second' })
    assert.equal((await pool.snapshot()).state.modelSelectionRequired, false)

    // 扩展加载错误只报告诊断，修复后重连会清除诊断
    await pool.setAccessMode(key, 'full-access')
    const extensionsDirectory = path.join(cwd, '.pi', 'extensions')
    await mkdir(extensionsDirectory, { recursive: true })
    const brokenExtension = path.join(extensionsDirectory, 'broken-extension.js')
    await writeFile(brokenExtension, "throw new Error('模拟扩展加载失败')\n")
    await pool.idle(() => pool.reconnectModels({ sessionFile: beforePath, model: { provider: 'fake', id: 'second' } }))
    assert.equal(pool.connection().status, 'ready')
    assert.ok(errors.some((message) => message.includes('Pi 扩展加载失败')))
    await rm(brokenExtension, { force: true })
    await pool.idle(() => pool.reconnectModels(), true)
    const restored = await pool.snapshot()
    assert.equal(restored.state.model?.id, 'second')
    assert.deepEqual(
      restored.messages.map((message) => message.role),
      before.messages.map((message) => message.role),
    )

    // 流式回复期间拒绝修改运行时配置
    await pool.prompt(key, 'slow')
    await waitFor(running)
    await assert.rejects(
      pool.idle(async () => {}),
      /正在运行/,
    )
    await pool.abort(key)
  } finally {
    pool.stop()
    await delay(100)
    await provider.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
