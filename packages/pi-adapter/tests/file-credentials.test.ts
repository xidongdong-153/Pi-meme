import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileCredentialStore } from '../src/file-credentials'

test('文件凭据初始化、并发更新、删除和重启恢复，权限为 0600', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-auth-'))
  try {
    const store = await FileCredentialStore.create(root)
    assert.deepEqual(JSON.parse(await readFile(store.filePath, 'utf8')), {})
    await Promise.all(['a', 'b'].map(async (id) => store.set(`model-provider:${id}`, `secret-${id}`)))
    await store.flush()
    assert.equal((await stat(store.filePath)).mode & 0o777, 0o600)
    let restored = await FileCredentialStore.create(root)
    assert.deepEqual(restored.entries('model-provider:'), [
      ['model-provider:a', 'secret-a'],
      ['model-provider:b', 'secret-b'],
    ])
    assert.equal(restored.delete('model-provider:a'), true)
    assert.equal(restored.delete('missing'), false)
    await restored.flush()
    restored = await FileCredentialStore.create(root)
    assert.equal(restored.get('model-provider:a'), undefined)
    assert.equal(restored.get('model-provider:b'), 'secret-b')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('损坏的凭据文件不会被初始化覆盖', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-auth-invalid-'))
  try {
    for (const source of ['{', 'null', '[]', '{"provider":42}']) {
      await writeFile(path.join(root, 'auth.json'), source)
      await assert.rejects(FileCredentialStore.create(root), /格式无效/)
      assert.equal(await readFile(path.join(root, 'auth.json'), 'utf8'), source)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('旧凭据只导入缺失项，重复导入不会覆盖文件中的新凭据', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-auth-import-'))
  try {
    const store = await FileCredentialStore.create(root)
    store.set('model-provider:a', 'new')
    await store.flush()
    const legacy: Array<[string, string]> = [
      ['model-provider:a', 'old'],
      ['mcp-oauth:b', 'oauth'],
    ]
    assert.deepEqual(await store.importMissing(legacy), { imported: 1, skipped: 1 })
    assert.deepEqual(await store.importMissing(legacy), { imported: 0, skipped: 2 })
    const restored = await FileCredentialStore.create(root)
    assert.equal(restored.get('model-provider:a'), 'new')
    assert.equal(restored.get('mcp-oauth:b'), 'oauth')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('写入失败恢复已保存内存值，并保留原文件内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-auth-failure-'))
  try {
    const store = await FileCredentialStore.create(root)
    store.set('existing', 'saved')
    await store.flush()
    await rename(root, `${root}-saved`)
    await writeFile(root, '阻止创建目录')
    await assert.rejects(store.importMissing([['new', 'unsaved']]), /凭据未保存/)
    assert.equal(store.get('new'), undefined)
    assert.equal(store.get('existing'), 'saved')
    assert.deepEqual(JSON.parse(await readFile(path.join(`${root}-saved`, 'auth.json'), 'utf8')), { existing: 'saved' })
    assert.throws(() => store.set('another', 'value'), /凭据未保存/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}-saved`, { recursive: true, force: true })
  }
})

test('凭据路径无法读取时拒绝初始化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-auth-read-'))
  try {
    await mkdir(path.join(root, 'auth.json'))
    await assert.rejects(FileCredentialStore.create(root), /无法读取/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
