import { readFile, writeFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { ImageConfigStore } from '../src/server/config-store'
import { imageFixture } from './fixture'

test('配置多模型、修订冲突、默认删除与重启恢复，配置不含凭据', async () => {
  const fixture = await imageFixture()
  try {
    const first = await fixture.save()
    expect(first.defaultId).toBe('first')
    expect(first.models[0].hasApiKey).toBe(true)
    expect(JSON.stringify(first)).not.toContain('image-test-secret')
    expect(await readFile(fixture.store.file, 'utf8')).not.toContain('image-test-secret')
    const second = await fixture.save('https://example.com/v1', 'second')
    expect(second.defaultId).toBe('first')
    await expect(fixture.store.setDefault('second', first.revision)).rejects.toThrow('配置已变化')
    const selected = await fixture.store.setDefault('second', second.revision)
    const restored = new ImageConfigStore(fixture.store.file, fixture.credentials)
    expect((await restored.selected()).id).toBe('second')
    const deleted = await restored.delete('second', selected.revision)
    expect(deleted.defaultId).toBeUndefined()
    await expect(restored.selected()).rejects.toThrow('请先')
    expect(fixture.credentials.entries()).toHaveLength(1)
  } finally {
    await fixture.dispose()
  }
})

test('替换与清除 Key，跨 origin 不能沿用旧凭据，损坏配置保留', async () => {
  const fixture = await imageFixture()
  try {
    let snapshot = await fixture.save()
    const { hasApiKey: _key, ...model } = snapshot.models[0]
    await expect(
      fixture.store.save({ revision: snapshot.revision, model: { ...model, baseUrl: 'https://other.example/v1' } }),
    ).rejects.toThrow('重新填写')
    snapshot = await fixture.store.save({ revision: snapshot.revision, model, apiKey: 'replacement' })
    expect((await fixture.store.selected()).apiKey).toBe('replacement')
    expect(fixture.credentials.entries()).toHaveLength(1)
    snapshot = await fixture.store.save({ revision: snapshot.revision, model, clearApiKey: true })
    expect(snapshot.models[0].hasApiKey).toBe(false)
    expect(fixture.credentials.entries()).toHaveLength(0)
    await writeFile(fixture.store.file, '{broken')
    expect((await fixture.store.snapshot()).error).toContain('原文件已保留')
    await expect(fixture.store.save({ revision: '', model, apiKey: 'new' })).rejects.toThrow('原文件已保留')
    expect(await readFile(fixture.store.file, 'utf8')).toBe('{broken')
  } finally {
    await fixture.dispose()
  }
})

test('凭据持久化失败不能确认保存或替换旧配置', async () => {
  const fixture = await imageFixture()
  try {
    const snapshot = await fixture.save()
    const original = await readFile(fixture.store.file, 'utf8')
    const { hasApiKey: _key, ...model } = snapshot.models[0]
    const failing = new ImageConfigStore(fixture.store.file, {
      get: (key) => fixture.credentials.get(key),
      set: (key, value) => fixture.credentials.set(key, value),
      delete: (key) => fixture.credentials.delete(key),
      entries: () => fixture.credentials.entries(),
      flush: async () => {
        throw new Error('凭据未保存')
      },
    })
    await expect(failing.save({ revision: snapshot.revision, model, apiKey: 'replacement' })).rejects.toThrow(
      '凭据未保存',
    )
    expect(await readFile(fixture.store.file, 'utf8')).toBe(original)
    expect((await fixture.store.selected()).apiKey).toBe('image-test-secret')
  } finally {
    await fixture.dispose()
  }
})
