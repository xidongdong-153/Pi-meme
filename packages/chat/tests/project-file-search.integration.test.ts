import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectFileSearch } from '../src/server/project-file-search'

test('项目文件补全列出目录、搜索嵌套文件，忽略生成目录和符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-files-'))
  try {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'README.md'), '')
    await writeFile(join(root, 'src', '中文 文件.ts'), '')
    await writeFile(join(root, 'src', 'composer-editor.tsx'), '')
    await writeFile(join(root, 'node_modules', 'composer.ts'), '')
    await writeFile(join(root, '.hidden'), '')
    await symlink(tmpdir(), join(root, 'outside'))
    const search = new ProjectFileSearch()
    assert.deepEqual(await search.list(root, ''), [
      { path: 'src', kind: 'directory' },
      { path: 'README.md', kind: 'file' },
    ])
    assert.deepEqual(await search.list(root, 'cmpedt'), [{ path: 'src/composer-editor.tsx', kind: 'file' }])
    assert.deepEqual(await search.list(root, 'src/中文 '), [{ path: 'src/中文 文件.ts', kind: 'file' }])
    assert.deepEqual(await search.list(root, '.'), [
      { path: '.hidden', kind: 'file' },
      { path: 'README.md', kind: 'file' },
      { path: 'src/composer-editor.tsx', kind: 'file' },
      { path: 'src/中文 文件.ts', kind: 'file' },
    ])
    assert.deepEqual(await search.list(root, '../'), [])
    assert.deepEqual(await search.list(root, `${tmpdir()}/`), [])
    assert.deepEqual(await search.list(root, 'outside/'), [])
    assert.deepEqual(await search.list(root, 'node_modules/'), [])
    await writeFile(join(root, 'src', 'new.ts'), '')
    assert.deepEqual(await search.list(root, 'src/new'), [{ path: 'src/new.ts', kind: 'file' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隐藏缓存目录不耗尽普通源码的扫描额度，显式隐藏路径仍可补全', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-files-hidden-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.cache'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'needle.ts'), '')
  for (let start = 0; start < 10000; start += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) => writeFile(join(root, '.cache', `${start + offset}.tmp`), '')),
    )
  }
  const search = new ProjectFileSearch()
  assert.deepEqual(await search.list(root, 'needle'), [{ path: 'src/needle.ts', kind: 'file' }])
  assert.ok((await search.list(root, '.')).some((entry) => entry.path === '.cache'))
  assert.equal((await search.list(root, '.cache/0'))[0]?.path, '.cache/0.tmp')
  assert.deepEqual(await search.list(root, 'needle'), [{ path: 'src/needle.ts', kind: 'file' }])
})

test('切换项目后不会使用上一项目的搜索索引', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-files-switch-'))
  try {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    await writeFile(join(root, 'a', 'only-a.ts'), '')
    await writeFile(join(root, 'b', 'only-b.ts'), '')
    const search = new ProjectFileSearch()
    assert.deepEqual(await search.list(join(root, 'a'), 'only'), [{ path: 'only-a.ts', kind: 'file' }])
    assert.deepEqual(await search.list(join(root, 'b'), 'only'), [{ path: 'only-b.ts', kind: 'file' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
