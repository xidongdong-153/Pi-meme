import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { loadSubagentCatalog, maxSubagentDefinitions, subagentCatalogSnapshot } from '../src/server/catalog'
import { defaultSubagentMaxTurns, parseSubagentDefinition } from '../src/server/definition'

function definition(id: string, extra = '') {
  return `---\nname: ${id}\ndescription: ${id} agent${extra}\n---\nInspect the requested task.`
}

test('SubAgent frontmatter 默认只读工具和 8 轮，并接受允许的工具与轮数覆盖', () => {
  const defaults = parseSubagentDefinition('/tmp/explorer.md', definition('explorer'), parseFrontmatter)
  assert.deepEqual(defaults.tools, ['read', 'grep', 'find', 'ls'])
  assert.equal(defaults.maxTurns, defaultSubagentMaxTurns)

  const configured = parseSubagentDefinition(
    '/tmp/fixer.md',
    `---\nname: fixer\ndescription: Fix code\ntools: [read, edit, write, bash]\nmaxTurns: 24\n---\nMake the requested change.`,
    parseFrontmatter,
  )
  assert.deepEqual(configured.tools, ['read', 'edit', 'write', 'bash'])
  assert.equal(configured.maxTurns, 24)
})

test('SubAgent frontmatter 拒绝无效名称、未知工具、空提示和超出范围的轮数', () => {
  for (const source of [
    definition('Bad_ID'),
    `---\nname: worker\ndescription: Worker\ntools: [read, shell]\n---\nPrompt`,
    `---\nname: worker\ndescription: Worker\nmaxTurns: 81\n---\nPrompt`,
    `---\nname: worker\ndescription: Worker\n---\n`,
    `---\nname: worker\ndescription: Worker\ntools: read\n---\nPrompt`,
  ]) {
    assert.throws(() => parseSubagentDefinition('/tmp/bad.md', source, parseFrontmatter))
  }
})

test('目录扫描隔离无效定义与重名定义，并限制最多加载 16 个 Agent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-subagents-catalog-'))
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'a.md'), definition('duplicate'))
    await writeFile(path.join(directory, 'b.md'), definition('duplicate'))
    await writeFile(path.join(directory, 'bad.md'), '---\nname: bad\n---\n')
    for (let index = 0; index < maxSubagentDefinitions + 2; index += 1)
      await writeFile(
        path.join(directory, `worker-${index.toString().padStart(2, '0')}.md`),
        definition(`worker-${index}`),
      )

    const catalog = await loadSubagentCatalog(directory, async () => parseFrontmatter)
    assert.equal(catalog.definitions.length, maxSubagentDefinitions)
    assert.equal(
      catalog.definitions.some((entry) => entry.id === 'duplicate'),
      false,
    )
    assert.equal(catalog.diagnostics.length, 5)
    assert.equal(subagentCatalogSnapshot(catalog, ['worker-0']).agents[0].enabled, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('不存在的全局定义目录返回空目录，不报错', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pi-subagents-empty-'))
  try {
    const catalog = await loadSubagentCatalog(path.join(parent, 'missing'), async () => parseFrontmatter)
    assert.deepEqual(catalog.definitions, [])
    assert.deepEqual(catalog.diagnostics, [])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
