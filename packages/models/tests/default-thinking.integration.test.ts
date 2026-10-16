import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readDefaultThinkingLevel, saveDefaultThinkingLevel } from '../src/server/default-thinking'

test('默认思考强度读写 Desktop Pi 目录 settings.json 并保留其他设置', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-default-thinking-'))
  try {
    await writeFile(
      path.join(directory, 'settings.json'),
      `${JSON.stringify({ theme: 'dark', defaultModel: 'kept-model' }, null, 2)}\n`,
    )
    assert.equal(await readDefaultThinkingLevel(directory), null)
    await saveDefaultThinkingLevel(directory, 'high')
    assert.equal(await readDefaultThinkingLevel(directory), 'high')
    const saved = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))
    assert.equal(saved.theme, 'dark')
    assert.equal(saved.defaultModel, 'kept-model')
    assert.equal(saved.defaultThinkingLevel, 'high')
    await saveDefaultThinkingLevel(directory, 'xhigh')
    assert.equal(await readDefaultThinkingLevel(directory), 'xhigh')
    await assert.rejects(saveDefaultThinkingLevel(directory, 'ultra' as 'high'), /思考强度参数无效/)
    assert.equal(await readDefaultThinkingLevel(directory), 'xhigh')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
