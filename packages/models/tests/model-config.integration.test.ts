import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createDesktopModelRuntime } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { ModelConfigStore } from '../src/server/config-store'
import { discoverModels, resolveCredential } from '../src/server/discovery'
import type { DiscoverModels, SaveModelProvider } from '@pi-meme/contracts/model-config'

async function temporary(
  work: (store: ModelConfigStore, directory: string, credentials: MemoryCredentialStorage) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-model-config-'))
  const credentials = new MemoryCredentialStorage()
  try {
    await work(
      new ModelConfigStore(path.join(directory, 'models.json'), credentials, directory),
      directory,
      credentials,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
function provider(revision: string): SaveModelProvider {
  return {
    revision,
    apiKey: 'private-key',
    provider: {
      id: 'local-test',
      name: '测试接口',
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'test-model' }],
    },
  }
}
test('保存模型配置后 Desktop Pi SDK 能读取模型，配置文件不保存明文 Key', async () =>
  temporary(async (store, _directory, credentials) => {
    const initial = await store.snapshot()
    const saved = await store.save(provider(initial.revision))
    assert.equal(saved.providers[0].hasApiKey, true)
    assert.ok(!JSON.stringify(saved).includes('private-key'))
    assert.ok(!JSON.stringify(JSON.parse(await readFile(store.filePath, 'utf8'))).includes('private-key'))
    assert.ok(credentials.get('model-provider:local-test')?.includes('private-key'))
    const runtime = await createDesktopModelRuntime(await loadPiSdk(), store.agentDir, credentials)
    const model = runtime.getModel('local-test', 'test-model')!
    assert.equal(model.contextWindow, 128000)
    assert.equal(model.maxTokens, 16384)
    assert.equal(model.reasoning, false)
    assert.deepEqual(model.input, ['text'])
  }))
test('编辑保留安全存储凭据和非敏感字段，并剔除旧文件中的明文凭据', async () =>
  temporary(async (store, _directory, credentials) => {
    credentials.set(
      'model-provider:local-test',
      JSON.stringify({ credential: { type: 'api_key', key: 'private-key' } }),
    )
    await writeFile(
      store.filePath,
      JSON.stringify({
        providers: {
          'local-test': {
            name: '原名称',
            api: 'openai-completions',
            baseUrl: 'http://localhost/v1',
            apiKey: 'private-key',
            authHeader: true,
            headers: { Authorization: 'private-header', 'X-Other': 'test' },
            modelOverrides: { builtin: { name: '覆盖' } },
            models: [
              {
                id: 'test-model',
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                samplingParams: { temperature: 0.2 },
                headers: { 'X-Api-Key': 'model-private' },
              },
            ],
          },
          other: {
            api: 'openai-responses',
            baseUrl: 'http://localhost/v1',
            apiKey: 'other-key',
            models: [{ id: 'other' }],
          },
        },
      }),
    )
    const snapshot = await store.snapshot()
    assert.ok(!JSON.stringify(snapshot).includes('private-header'))
    assert.ok(!JSON.stringify(snapshot).includes('model-private'))
    const edited = provider(snapshot.revision)
    edited.originalId = 'local-test'
    delete edited.apiKey
    edited.provider.headers = snapshot.providers.find((p) => p.id === 'local-test')!.headers
    edited.provider.models[0].headers = { 'X-Api-Key': '' }
    await store.save(edited)
    const data = JSON.parse(await readFile(store.filePath, 'utf8'))
    assert.equal(data.providers['local-test'].apiKey, undefined)
    assert.equal(data.providers['local-test'].headers.Authorization, undefined)
    assert.equal(data.providers['local-test'].models[0].headers?.['X-Api-Key'], undefined)
    assert.equal(data.providers['local-test'].models[0].cost.input, 1)
    assert.deepEqual(data.providers['local-test'].models[0].samplingParams, { temperature: 0.2 })
    assert.equal(data.providers['local-test'].modelOverrides.builtin.name, '覆盖')
    assert.equal(data.providers.other.apiKey, undefined)
    assert.ok(credentials.get('model-provider:local-test')?.includes('private-key'))
    assert.equal(data.providers['local-test'].authHeader, true)
    const next = await store.snapshot()
    await store.save({ ...edited, revision: next.revision, clearApiKey: true })
    assert.equal((await store.snapshot()).providers.find((p) => p.id === 'local-test')!.hasApiKey, false)
  }))
test('支持 JSONC；删除只修改目标服务商；外部文件变更拒绝覆盖', async () =>
  temporary(async (store) => {
    await writeFile(store.filePath, '{\n// 本地配置\n"providers": {"local": {"models": [{"id":"a"}]}, "other": {}}\n}')
    const initial = await store.snapshot()
    await writeFile(store.filePath, '{"providers":{"external":{}}}')
    await assert.rejects(store.delete('local', initial.revision), /其他程序修改/)
    assert.ok((await readFile(store.filePath, 'utf8')).includes('external'))
    const next = await store.snapshot()
    await store.delete('external', next.revision)
    assert.deepEqual((await store.snapshot()).providers, [])
    await writeFile(store.filePath, '{ bad json')
    await assert.rejects(store.snapshot(), /JSON 无效/)
    await assert.rejects(store.save(provider(next.revision)))
    assert.equal(await readFile(store.filePath, 'utf8'), '{ bad json')
  }))
test('非法 URL、重复 ID、非正整数和无效高级字段不会写入配置', async () =>
  temporary(async (store) => {
    const revision = (await store.snapshot()).revision
    for (const baseUrl of ['file:///tmp/model', 'http://user:pass@localhost/v1', 'https://example.com/v1?key=secret']) {
      const input = provider(revision)
      input.provider.baseUrl = baseUrl
      await assert.rejects(store.save(input), /HTTP\(S\)/)
    }
    const duplicate = provider(revision)
    duplicate.provider.models.push({ id: 'test-model' })
    await assert.rejects(store.save(duplicate), /不能重复/)
    const invalid = provider(revision)
    invalid.provider.models[0].maxTokens = 1.2
    await assert.rejects(store.save(invalid), /正整数/)
    const advanced = provider(revision)
    advanced.provider.models[0].thinkingLevelMap = { invalid: 'high' }
    await assert.rejects(store.save(advanced), /思考等级映射/)
    const schema = provider(revision)
    schema.provider.models[0].compat = { maxTokensField: 'incorrect' }
    await assert.rejects(store.save(schema), /compat.maxTokensField/)
    assert.deepEqual((await store.snapshot()).providers, [])
  }))
function discoveryInput(api: DiscoverModels['api']): DiscoverModels {
  return {
    api,
    baseUrl: 'http://localhost/v1',
    apiKey: 'test-key',
  }
}
test('OpenAI 两种协议共用 /models，去重并使用 Bearer 鉴权', async () =>
  temporary(async (store) => {
    for (const api of ['openai-completions', 'openai-responses'] as const) {
      const request: typeof fetch = async (input, options) => {
        assert.equal(String(input), 'http://localhost/v1/models')
        assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-key')
        assert.equal(options?.redirect, 'error')
        return Response.json({ data: [{ id: 'one' }, { id: 'one' }, { id: 'two' }] })
      }
      assert.deepEqual(await discoverModels(discoveryInput(api), store, request), [{ id: 'one' }, { id: 'two' }])
    }
  }))
test('Anthropic 避免重复 /v1，按游标分页并读取明确的模型能力', async () =>
  temporary(async (store) => {
    let calls = 0
    const request: typeof fetch = async (input, options) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/v1/models')
      assert.equal(new Headers(options?.headers).get('x-api-key'), 'test-key')
      assert.equal(new Headers(options?.headers).get('anthropic-version'), '2023-06-01')
      calls++
      if (calls === 1)
        return Response.json({
          data: [
            {
              id: 'a',
              display_name: 'A',
              max_input_tokens: 100000,
              max_tokens: 8192,
              capabilities: { thinking: { supported: true }, image_input: { supported: true } },
            },
          ],
          has_more: true,
          last_id: 'a',
        })
      assert.equal(url.searchParams.get('after_id'), 'a')
      return Response.json({ data: [{ id: 'b' }], has_more: false })
    }
    const result = await discoverModels(discoveryInput('anthropic-messages'), store, request)
    assert.equal(calls, 2)
    assert.deepEqual(result[0], {
      id: 'a',
      name: 'A',
      contextWindow: 100000,
      maxTokens: 8192,
      reasoning: true,
      input: ['text', 'image'],
    })
  }))
test('Google 分页、过滤非 generateContent 模型并归一化模型 ID', async () =>
  temporary(async (store) => {
    let calls = 0
    const request: typeof fetch = async (input, options) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/v1beta/models')
      assert.equal(new Headers(options?.headers).get('x-goog-api-key'), 'test-key')
      calls++
      if (calls === 1)
        return Response.json({
          models: [
            {
              name: 'models/gemini-test',
              displayName: '测试',
              inputTokenLimit: 65536,
              outputTokenLimit: 8192,
              thinking: true,
              supportedGenerationMethods: ['generateContent'],
            },
            { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'next',
        })
      assert.equal(url.searchParams.get('pageToken'), 'next')
      return Response.json({
        models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }],
      })
    }
    const result = await discoverModels(
      { ...discoveryInput('google-generative-ai'), baseUrl: 'http://localhost/v1beta' },
      store,
      request,
    )
    assert.deepEqual(result, [
      { id: 'gemini-test', name: '测试', contextWindow: 65536, maxTokens: 8192, reasoning: true },
    ])
  }))
test('列表请求拒绝命令凭据、鉴权失败、异常响应和重复分页，错误不包含秘密', async () =>
  temporary(async (store) => {
    let calls = 0
    const request: typeof fetch = async () => {
      calls++
      return Response.json({ error: 'secret-key' }, { status: 401 })
    }
    await assert.rejects(
      discoverModels({ ...discoveryInput('openai-completions'), apiKey: '!echo secret' }, store, request),
      /不会执行命令/,
    )
    assert.equal(calls, 0)
    await assert.rejects(
      discoverModels({ ...discoveryInput('openai-completions'), apiKey: 'secret-key' }, store, request),
      (error) => error instanceof Error && error.message.includes('鉴权失败') && !error.message.includes('secret-key'),
    )
    await assert.rejects(
      discoverModels(discoveryInput('openai-completions'), store, async () => Response.json({ invalid: [] })),
      /缺少模型数组/,
    )
    await assert.rejects(
      discoverModels(discoveryInput('anthropic-messages'), store, async () =>
        Response.json({ data: [], has_more: true, last_id: 'same' }),
      ),
      /游标无效/,
    )
    await assert.rejects(
      discoverModels(
        discoveryInput('openai-completions'),
        store,
        async (_url, options) => {
          await new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('请求未中止')), 1000)
            options?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(new Error('secret-key'))
              },
              { once: true },
            )
          })
          return Response.json({ data: [] })
        },
        10,
      ),
      /超时/,
    )
  }))
test('环境变量中的 Key 不会被读取或保存', async () =>
  temporary(async (store) => {
    const original = process.env.PI_DESKTOP_MODEL_TEST_KEY
    process.env.PI_DESKTOP_MODEL_TEST_KEY = 'env-secret'
    try {
      const input = provider((await store.snapshot()).revision)
      input.apiKey = `\${PI_DESKTOP_MODEL_TEST_KEY}`
      await assert.rejects(store.save(input), /不能引用环境变量/)
      assert.throws(() => resolveCredential('$PI_DESKTOP_MODEL_TEST_KEY'), /不能引用环境变量/)
    } finally {
      if (original === undefined) delete process.env.PI_DESKTOP_MODEL_TEST_KEY
      else process.env.PI_DESKTOP_MODEL_TEST_KEY = original
    }
  }))

test('SDK 拒绝加载的已有模型字段不会被覆盖', async () =>
  temporary(async (store) => {
    const original = JSON.stringify({
      providers: {
        'local-test': {
          api: 'openai-completions',
          baseUrl: 'http://localhost/v1',
          apiKey: 'private-key',
          models: [{ id: 'test-model', cost: { input: 'invalid', output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    })
    await writeFile(store.filePath, original)
    const input = provider((await store.snapshot()).revision)
    input.originalId = 'local-test'
    await assert.rejects(store.save(input), /Pi 无法加载/)
    assert.equal(await readFile(store.filePath, 'utf8'), original)
  }))
test('敏感请求头留空保留，换行凭据拒绝发送；列表分页最多 20 页', async () =>
  temporary(async (store) => {
    const input = provider((await store.snapshot()).revision)
    input.provider.headers = { Authorization: 'header-secret' }
    await store.save(input)
    await discoverModels(
      {
        providerId: 'local-test',
        baseUrl: 'http://localhost/v1',
        api: 'openai-completions',
        clearApiKey: true,
        headers: { Authorization: '' },
      },
      store,
      async (_url, options) => {
        assert.equal(new Headers(options?.headers).get('authorization'), 'header-secret')
        return Response.json({ data: [] })
      },
    )
    await assert.rejects(
      discoverModels({ ...discoveryInput('openai-completions'), apiKey: 'private\nsecret' }, store),
      (error) => error instanceof Error && !error.message.includes('private') && !error.message.includes('secret'),
    )
    let pages = 0
    await assert.rejects(
      discoverModels(discoveryInput('anthropic-messages'), store, async () => {
        pages++
        return Response.json({ data: [], has_more: true, last_id: `page-${pages}` })
      }),
      /超过 20 页/,
    )
    assert.equal(pages, 20)
  }))

test('思考档位映射保存后由 Pi 读取，发现模型保留显式能力', async () =>
  temporary(async (store, _directory, credentials) => {
    const thinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: 'max' }
    const discovered = await discoverModels(discoveryInput('openai-responses'), store, async () =>
      Response.json({ data: [{ id: 'test-model', reasoning: true, thinkingLevelMap }] }),
    )
    assert.deepEqual(discovered, [{ id: 'test-model', reasoning: true, thinkingLevelMap }])
    const input = provider((await store.snapshot()).revision)
    input.provider.models = discovered
    await store.save(input)
    const runtime = await createDesktopModelRuntime(await loadPiSdk(), store.agentDir, credentials)
    const model = runtime.getModel('local-test', 'test-model')!
    assert.deepEqual(model.thinkingLevelMap, thinkingLevelMap)
    input.revision = (await store.snapshot()).revision
    input.provider.models[0].thinkingLevelMap = { ...thinkingLevelMap, max: null }
    await assert.rejects(store.save(input), /至少保留一个/)
    input.provider.models[0].thinkingLevelMap = { max: '' }
    await assert.rejects(store.save(input), /非空字符串/)
  }))
