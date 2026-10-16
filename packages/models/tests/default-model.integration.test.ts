import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readDefaultModel, saveDefaultModel } from '../src/server/default-model'

test('默认模型读写 Desktop Pi 目录 settings.json 并保留其他设置', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-default-model-'))
  try {
    await writeFile(path.join(directory, 'settings.json'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`)
    assert.equal(await readDefaultModel(directory), null)
    await saveDefaultModel(directory, 'local-test', 'test-model')
    assert.deepEqual(await readDefaultModel(directory), { provider: 'local-test', id: 'test-model' })
    const saved = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))
    assert.equal(saved.theme, 'dark')
    assert.equal(saved.defaultProvider, 'local-test')
    assert.equal(saved.defaultModel, 'test-model')
    await saveDefaultModel(directory, 'other', 'next-model')
    assert.deepEqual(await readDefaultModel(directory), { provider: 'other', id: 'next-model' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
