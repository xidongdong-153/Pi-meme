import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkspaceFiles, maxFilePreviewBytes } from '../src/workspace-files'

test('文件预览限定目标目录，拒绝越界链接、二进制和过大文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-files-'))
  try {
    const project = path.join(root, 'project')
    await mkdir(project)
    await mkdir(path.join(project, 'folder'))
    await writeFile(path.join(project, 'readme.txt'), '中文文本')
    await writeFile(path.join(root, 'secret.txt'), 'outside')
    await symlink(path.join(root, 'secret.txt'), path.join(project, 'outside'))
    await symlink(path.join(project, 'readme.txt'), path.join(project, 'inside'))
    await writeFile(path.join(project, 'large.txt'), Buffer.alloc(maxFilePreviewBytes + 1, 'a'))
    await writeFile(path.join(project, 'binary'), Buffer.from([0, 255]))
    const files = createWorkspaceFiles(async (ref) => {
      assert.equal('projectId' in ref && ref.projectId, 'p')
      return project
    })
    const ref = { hostId: 'h', projectId: 'p' }
    assert.equal((await files.list(ref))[0].name, 'folder')
    assert.equal(
      (await files.list(ref)).some((item) => item.name === 'outside'),
      false,
    )
    assert.equal((await files.read(ref, 'inside')).content, '中文文本')
    for (const filename of ['../secret.txt', '/etc/passwd', 'outside', 'large.txt', 'binary', 'folder'])
      await assert.rejects(files.read(ref, filename))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
