import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readDesktopAgentContextFiles } from '../src/sdk/context-files'

test('上下文只读取 Desktop 与当前项目的 AGENTS 文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-context-isolation-'))
  const parent = path.join(directory, 'parent')
  const cwd = path.join(parent, 'project')
  const agentDir = path.join(directory, 'userData', 'pi')
  const contents = new Map([
    [path.join(parent, 'AGENTS.md'), 'parent context'],
    [path.join(cwd, 'AGENTS.md'), 'project context'],
    [path.join(cwd, 'AGENTS.override.md'), 'project override'],
    [path.join(cwd, 'CLAUDE.md'), 'project Claude context'],
    [path.join(agentDir, 'AGENTS.md'), 'Desktop context'],
    [path.join(agentDir, 'CLAUDE.md'), 'host Claude context'],
  ])
  await Promise.all(
    [...contents].map(async ([file, content]) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
    }),
  )

  try {
    const files = readDesktopAgentContextFiles(cwd, agentDir)
    assert.deepEqual(files, [
      { path: await realpath(path.join(agentDir, 'AGENTS.md')), content: 'Desktop context' },
      { path: await realpath(path.join(cwd, 'AGENTS.override.md')), content: 'project override' },
    ])
    for (const [file, content] of contents) assert.equal(await readFile(file, 'utf8'), content)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('上下文文件的符号链接不能读取允许目录之外的文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-context-symlink-'))
  const cwd = path.join(directory, 'project')
  const agentDir = path.join(directory, 'userData', 'pi')
  const outside = path.join(directory, 'outside.md')
  await mkdir(cwd, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeFile(outside, 'outside context')
  await import('node:fs/promises').then(({ symlink }) => symlink(outside, path.join(cwd, 'AGENTS.md')))

  try {
    assert.deepEqual(readDesktopAgentContextFiles(cwd, agentDir), [])
    assert.equal(await readFile(outside, 'utf8'), 'outside context')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
