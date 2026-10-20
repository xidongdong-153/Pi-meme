import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkspaceFiles, maxFilePreviewBytes, maxImagePreviewBytes } from '../src/workspace-files'

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
    await writeFile(path.join(root, 'outside.png'), 'outside')
    await symlink(path.join(root, 'outside.png'), path.join(project, 'outside.png'))
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
    for (const filename of ['../outside.png', path.join(root, 'outside.png'), 'outside.png'])
      await assert.rejects(files.preview(ref, filename))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('附件图片绝对路径仅可预览，保留目标校验、大小限制和附件目录边界', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'app-attachment-preview-')))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project')
  const attachments = path.join(root, 'attachments')
  const upload = path.join(attachments, 'upload-test')
  await mkdir(project)
  await mkdir(upload, { recursive: true })
  const image = Buffer.from('image bytes')
  const filename = path.join(upload, 'image.png')
  await writeFile(filename, image)
  await writeFile(path.join(upload, 'notes.txt'), '不允许读取附件文本')
  await writeFile(path.join(upload, 'large.png'), Buffer.alloc(maxImagePreviewBytes + 1))
  await writeFile(path.join(root, 'outside.png'), image)
  await symlink(path.join(root, 'outside.png'), path.join(upload, 'outside.png'))
  await symlink(attachments, path.join(root, 'linked-attachments'))
  const files = createWorkspaceFiles(async (ref) => {
    if (ref.hostId !== 'host') throw new Error('目标 Host 无效')
    return project
  }, attachments)
  const ref = { hostId: 'host', sessionId: 'session' }
  assert.deepEqual(await files.preview(ref, filename), {
    kind: 'image',
    relativePath: filename,
    dataUrl: `data:image/png;base64,${image.toString('base64')}`,
    size: image.length,
  })
  assert.deepEqual(await files.preview(ref, path.join(upload, 'large.png')), {
    kind: 'unsupported',
    relativePath: path.join(upload, 'large.png'),
    reason: 'too-large',
  })
  for (const invalid of [
    path.join(root, 'outside.png'),
    path.join(upload, 'outside.png'),
    path.join(upload, 'notes.txt'),
  ])
    await assert.rejects(files.preview(ref, invalid))
  await assert.rejects(files.preview({ ...ref, hostId: 'wrong-host' }, filename), /目标 Host 无效/)
  await assert.rejects(files.read(ref, filename))
  await assert.rejects(files.list(ref, upload))
  await assert.rejects(files.write(ref, { relativePath: filename, content: '不允许写入', revision: '' }))
  const linked = createWorkspaceFiles(async () => project, path.join(root, 'linked-attachments'))
  await assert.rejects(linked.preview(ref, path.join(root, 'linked-attachments', 'upload-test', 'image.png')))
})

test('文件分类预览与保存保留 BOM、CRLF、权限，并拒绝冲突、越界和并发覆盖', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-files-edit-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project')
  await mkdir(project)
  const filename = path.join(project, 'file.ts')
  await writeFile(filename, '\uFEFFconst old = 1\r\n', { mode: 0o640 })
  await writeFile(path.join(root, 'outside.txt'), '不可写')
  await symlink(path.join(root, 'outside.txt'), path.join(project, 'outside'))
  const files = createWorkspaceFiles(async () => project)
  const ref = { hostId: 'host', sessionId: 'session' }
  const preview = await files.preview(ref, 'file.ts')
  assert.equal(preview.kind, 'text')
  if (preview.kind !== 'text') throw new Error('必须是文本')
  const saved = await files.write(ref, {
    relativePath: 'file.ts',
    content: 'const next = 2\n',
    revision: preview.revision,
  })
  assert.notEqual(saved.revision, preview.revision)
  const { readFile, stat } = await import('node:fs/promises')
  assert.equal(await readFile(filename, 'utf8'), '\uFEFFconst next = 2\r\n')
  assert.equal((await stat(filename)).mode & 0o777, 0o640)
  await assert.rejects(
    files.write(ref, { relativePath: 'file.ts', content: '覆盖', revision: preview.revision }),
    /其他程序修改/,
  )
  await assert.rejects(files.write(ref, { relativePath: 'outside', content: '覆盖', revision: saved.revision }), /越出/)
  await assert.rejects(files.write(ref, { relativePath: 'missing', content: '新建', revision: saved.revision }))
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), '不可写')
  const concurrent = await Promise.allSettled(
    ['A', 'B'].map((content) => files.write(ref, { relativePath: 'file.ts', content, revision: saved.revision })),
  )
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(
    (await readdir(project)).some((name) => name.startsWith('.pi-meme-')),
    false,
  )
})

test('图片、二进制、编码和大小边界分别返回可识别的预览结果', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-files-preview-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const files = createWorkspaceFiles(async () => root)
  const ref = { hostId: 'host', projectId: 'project' }
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2m1sAAAAASUVORK5CYII=',
    'base64',
  )
  await writeFile(path.join(root, 'image.png'), image)
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 255]))
  await writeFile(path.join(root, 'invalid'), Buffer.from([255]))
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(maxFilePreviewBytes + 1))
  await writeFile(path.join(root, 'large.png'), Buffer.alloc(maxImagePreviewBytes + 1))
  assert.deepEqual(await files.preview(ref, 'image.png'), {
    kind: 'image',
    relativePath: 'image.png',
    dataUrl: `data:image/png;base64,${image.toString('base64')}`,
    size: image.length,
  })
  for (const [filename, reason] of [
    ['binary', 'binary'],
    ['invalid', 'encoding'],
    ['large.txt', 'too-large'],
    ['large.png', 'too-large'],
  ])
    assert.deepEqual(await files.preview(ref, filename), { kind: 'unsupported', relativePath: filename, reason })
})

test('文件名搜索分页绑定目标和查询，跳过依赖目录并拒绝越界与目录循环', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-files-search-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'folder'))
  await mkdir(path.join(root, 'node_modules'))
  await writeFile(path.join(root, 'node_modules', 'find-hidden.ts'), '依赖')
  await symlink(root, path.join(root, 'folder', 'cycle'))
  await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(path.join(root, 'folder', `find-${i}.ts`), '')))
  const files = createWorkspaceFiles(async () => root)
  const ref = { hostId: 'host', sessionId: 'session' }
  const first = await files.search(ref, { query: 'find-' })
  assert.equal(first.entries.length, 100)
  assert.ok(first.nextCursor)
  await assert.rejects(
    files.search({ ...ref, sessionId: 'other' }, { query: 'find-', cursor: first.nextCursor }),
    /过期/,
  )
  await assert.rejects(files.search(ref, { query: 'different', cursor: first.nextCursor }), /过期/)
  const rest = await files.search(
    { sessionId: ref.sessionId, hostId: ref.hostId },
    { query: 'find-', cursor: first.nextCursor },
  )
  assert.equal(rest.entries.length, 20)
  assert.equal(rest.nextCursor, undefined)
  assert.equal(new Set([...first.entries, ...rest.entries].map((entry) => entry.relativePath)).size, 120)
})
