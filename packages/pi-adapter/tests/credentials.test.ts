import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeychainCredentialStore } from '../src/credentials'

test('钥匙串没有条目时的 null 返回值初始化为空存储，不写入钥匙串', async () => {
  let writes = 0
  const store = await KeychainCredentialStore.create('/test', {
    getPassword: async () => null,
    setPassword: async () => {
      writes++
    },
  })
  assert.deepEqual(store.entries(), [])
  assert.equal(writes, 0)
})

test('已存在的非字典凭据仍拒绝加载，不覆盖原内容', async () => {
  let writes = 0
  await assert.rejects(
    KeychainCredentialStore.create('/test', {
      getPassword: async () => 'null',
      setPassword: async () => {
        writes++
      },
    }),
    /钥匙串凭据格式无效/,
  )
  assert.equal(writes, 0)
})

test('两个provider并发更新经过Host合并，钥匙串写入保留全部键', async () => {
  let saved: string | undefined
  const store = await KeychainCredentialStore.create('/test', {
    getPassword: async () => saved,
    setPassword: async (value) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      saved = value
    },
  })
  await Promise.all([
    Promise.resolve().then(() => store.set('provider:a', 'secret-a')),
    Promise.resolve().then(() => store.set('provider:b', 'secret-b')),
  ])
  await store.flush()
  assert.deepEqual(JSON.parse(saved!), { 'provider:a': 'secret-a', 'provider:b': 'secret-b' })
})

test('系统钥匙串写入失败拒绝完成凭据操作', async () => {
  const store = await KeychainCredentialStore.create('/test', {
    getPassword: async () => undefined,
    setPassword: async () => {
      throw new Error('locked')
    },
  })
  store.set('provider:a', 'secret')
  await assert.rejects(store.flush(), /凭据未保存/)
  assert.throws(() => store.get('provider:a'), /凭据未保存/)
})
