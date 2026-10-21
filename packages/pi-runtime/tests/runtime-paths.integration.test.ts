import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { createPiRuntimePaths } from '../src/runtime-paths'

test('Pi 运行数据位于规范化 dataRoot，工作区按规范化路径分组', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-runtime-paths-'))
  const dataRoot = path.join(directory, 'dataRoot')
  const workspace = path.join(directory, 'workspace')
  const alias = path.join(directory, 'workspace-alias')
  await mkdir(workspace)
  await symlink(workspace, alias)
  try {
    const paths = createPiRuntimePaths(dataRoot)
    const canonical = await realpath(workspace)
    assert.equal(paths.dataRoot, dataRoot)
    assert.equal(paths.agentDir, path.join(dataRoot, storageLayoutRelativePaths.agentDirectory))
    assert.equal(paths.skillsDirectory, path.join(dataRoot, storageLayoutRelativePaths.skillsDirectory))
    assert.equal(paths.builtinSkillsDirectory, path.join(dataRoot, storageLayoutRelativePaths.builtinSkillsDirectory))
    assert.equal(paths.sessionsDirectory, path.join(dataRoot, storageLayoutRelativePaths.sessionsDataDirectory))
    assert.equal(paths.workspaceDataRoot, path.join(dataRoot, storageLayoutRelativePaths.workspacesConfigDirectory))
    assert.equal(paths.workspaceKey(workspace), paths.workspaceKey(alias))
    assert.equal(paths.workspaceDirectory(workspace), paths.workspaceDirectory(alias))
    assert.equal(paths.sessionDirectory(workspace), paths.sessionDirectory(alias))
    assert.equal(paths.workspaceKey(workspace).length, 64)
    assert.ok(paths.sessionDirectory(workspace).startsWith(`${paths.sessionsDirectory}${path.sep}`))
    assert.ok(paths.workspaceDirectory(workspace).startsWith(`${paths.workspaceDataRoot}${path.sep}`))
    assert.equal(paths.workspaceKey(canonical), paths.workspaceKey(workspace))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
