import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPiRuntimePaths } from '../src/runtime-paths'

test('Pi 运行数据位于 Desktop userData，工作区按规范化路径分组', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-runtime-paths-'))
  const userData = path.join(directory, 'userData')
  const workspace = path.join(directory, 'workspace')
  const alias = path.join(directory, 'workspace-alias')
  await mkdir(workspace)
  await symlink(workspace, alias)
  try {
    const paths = createPiRuntimePaths(userData)
    const canonical = await realpath(workspace)
    assert.equal(paths.agentDir, path.join(userData, 'pi'))
    assert.equal(paths.dataRoot, userData)
    assert.equal(paths.skillsDirectory, path.join(userData, 'skills'))
    assert.equal(paths.builtinSkillsDirectory, path.join(userData, 'builtin-resources', 'skills'))
    assert.equal(paths.sessionsDirectory, path.join(userData, 'sessions'))
    assert.equal(paths.secureCredentialsFile, path.join(userData, 'secure', 'credentials.bin'))
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
