import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createBuiltinAuth } from '../src/server/builtin-auth'
import { ModelConfigStore } from '../src/server/config-store'
import type { SaveModelProvider } from '@pi-meme/contracts/model-config'

test('内置服务商可使用 API Key 登录和退出，自定义服务商不出现在列表中', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-builtin-auth-'))
  const credentials = new MemoryCredentialStorage()
  const store = new ModelConfigStore(path.join(directory, 'models.json'), credentials, directory)
  let reconnects = 0
  try {
    const initial = await store.snapshot()
    const custom: SaveModelProvider = {
      revision: initial.revision,
      apiKey: 'custom-key',
      provider: {
        id: 'local-test',
        name: '测试接口',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [{ id: 'test-model' }],
      },
    }
    await store.save(custom)
    const auth = createBuiltinAuth({
      agentDir: directory,
      modelsPath: store.filePath,
      credentials,
      reconnect: async () => {
        reconnects += 1
        return undefined
      },
    })
    const listed = await auth.providers()
    assert.equal(
      listed.some((provider) => provider.id === 'local-test'),
      false,
    )
    const anthropic = listed.find((provider) => provider.id === 'anthropic')
    assert.ok(anthropic)
    assert.equal(anthropic.configured, false)
    assert.equal(
      anthropic.methods.some((method) => method.type === 'api_key' && method.interactive),
      true,
    )
    assert.equal(
      anthropic.methods.some((method) => method.type === 'oauth' && method.subscription && method.interactive),
      true,
    )
    assert.ok(listed.length > 10)
    await assert.rejects(() => auth.start({ providerId: 'local-test', authType: 'api_key' }), /不是内置服务商/)

    const started = await auth.start({ providerId: 'anthropic', authType: 'api_key' })
    assert.equal(started.status, 'needs_input')
    assert.equal(started.prompt?.type, 'secret')
    await assert.rejects(() => auth.start({ providerId: 'google', authType: 'api_key' }), /已有登录正在进行/)
    await assert.rejects(
      () => auth.respond({ id: started.id, promptId: started.prompt?.id, value: '   ' }),
      /请输入内容/,
    )
    assert.equal((await auth.cancel())?.status, 'cancelled')

    const again = await auth.start({ providerId: 'anthropic', authType: 'api_key' })
    const done = await auth.respond({ id: again.id, promptId: again.prompt?.id, value: 'sk-ant-test' })
    assert.equal(done.status, 'done', done.error)
    assert.equal(JSON.stringify(done).includes('sk-ant-test'), false)
    assert.equal(reconnects, 1)
    assert.match(await readFile(path.join(directory, 'device-id'), 'utf8'), /^[0-9a-f-]{36}\n$/i)
    const signedIn = (await auth.providers()).find((provider) => provider.id === 'anthropic')
    assert.equal(signedIn?.configured, true)
    assert.equal(signedIn?.authType, 'api_key')
    assert.match(credentials.get('model-provider:anthropic') ?? '', /sk-ant-test/)

    const loggedOut = await auth.logout('anthropic')
    assert.equal(loggedOut.providers.find((provider) => provider.id === 'anthropic')?.configured, false)
    assert.equal(credentials.get('model-provider:anthropic'), undefined)
    assert.equal(reconnects, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
