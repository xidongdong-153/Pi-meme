import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SafeStorageCredentialStore, type SafeStorageAdapter } from '../src/secure-store'

function fakeSafeStorage() {
  let available = true
  const adapter: SafeStorageAdapter = {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      const encoded = value.toString().slice('encrypted:'.length)
      return Buffer.from(encoded, 'base64').toString()
    },
  }
  return { adapter, setAvailable: (value: boolean) => (available = value) }
}

test('安全凭据只写密文，safeStorage 不可用时拒绝写入和读取', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-secure-store-'))
  const file = path.join(directory, 'secure', 'credentials.bin')
  const safeStorage = fakeSafeStorage()
  const store = new SafeStorageCredentialStore(file, safeStorage.adapter)
  try {
    const secret = 'model-api-key-should-not-appear'
    store.set('model-provider:local', JSON.stringify({ credential: { type: 'api_key', key: secret } }))
    const ciphertext = await readFile(file)
    assert.equal(ciphertext.includes(Buffer.from(secret)), false)
    assert.deepEqual(store.entries('model-provider:'), [
      ['model-provider:local', JSON.stringify({ credential: { type: 'api_key', key: secret } })],
    ])

    safeStorage.setAvailable(false)
    assert.throws(() => store.set('mcp-oauth:test', 'oauth-secret'), /安全存储不可用/)
    assert.throws(() => store.get('model-provider:local'), /安全存储不可用/)
    assert.equal((await readFile(file)).includes(Buffer.from(secret)), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('新凭据在安全存储不可用时不会创建明文回退文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-secure-store-unavailable-'))
  const file = path.join(directory, 'credentials.bin')
  const safeStorage = fakeSafeStorage()
  safeStorage.setAvailable(false)
  const store = new SafeStorageCredentialStore(file, safeStorage.adapter)
  try {
    assert.throws(() => store.set('model-provider:local', 'api-key'), /安全存储不可用/)
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
