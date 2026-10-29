import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { ImageLibraryStore, type ImageLibraryCandidate, type ImageLibraryHistory } from '../src/server/library-store'
import { png } from './fixture'

async function fixture(history: () => Promise<ImageLibraryHistory[]> = async () => []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-image-library-')))
  const attachments = path.join(root, 'attachments')
  await mkdir(attachments)
  const image = path.join(attachments, 'image.png')
  await writeFile(image, png)
  const options = { hostId: 'host', file: path.join(root, 'library.json'), attachments, history, onChange: vi.fn() }
  const create = () => new ImageLibraryStore(options)
  const candidate: ImageLibraryCandidate = {
    artifact: { id: 'image', path: image, mimeType: 'image/png', operation: 'generate', model: 'test', sources: [] },
    prompt: '白色小猫\n透明背景',
    createdAt: '2026-10-29T01:00:00.000Z',
    session: { hostId: 'host', sessionId: 'session' },
    project: { hostId: 'host', projectId: 'project' },
    projectName: '项目',
  }
  return { root, options, create, candidate, image, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('图像索引重启后保留名称与移除记录，不修改原图，也不依赖来源会话', async () => {
  const f = await fixture()
  let store = f.create()
  try {
    await store.add(f.candidate)
    expect((await store.list()).items[0]).toMatchObject({ name: '白色小猫', width: 1, height: 1 })
    await store.rename('image', '封面')
    await store.add(f.candidate)
    await store.dispose()
    store = f.create()
    expect((await store.list({ query: '封面', projectId: 'project' })).items).toHaveLength(1)
    expect((await store.read('image')).dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)
    await store.remove('image')
    await store.dispose()
    store = f.create()
    await store.add(f.candidate)
    expect((await store.list()).items).toHaveLength(0)
    await expect(store.read('image')).rejects.toThrow('已移除')
    expect(await readFile(f.image)).toEqual(png)
  } finally {
    await store.dispose()
    await f.dispose()
  }
})

test('历史补录按作品去重，保存进度，跳过缺失文件，保留重命名', async () => {
  const read = vi.fn<() => Promise<ImageLibraryCandidate[]>>()
  const f = await fixture(async () => [{ key: 'session', revision: 'one', read }])
  read.mockResolvedValue([
    f.candidate,
    f.candidate,
    {
      ...f.candidate,
      artifact: { ...f.candidate.artifact, id: 'missing', path: path.join(f.root, 'attachments/missing.png') },
    },
  ])
  let store = f.create()
  try {
    await store.list()
    await vi.waitFor(async () => expect((await store.list()).scan.running).toBe(false))
    expect((await store.list()).scan.skipped).toBe(1)
    expect((await store.list()).items).toHaveLength(1)
    await store.rename('image', '新名字')
    await store.dispose()
    store = f.create()
    await store.list()
    await vi.waitFor(async () => expect((await store.list()).scan.running).toBe(false))
    expect((await store.list()).items[0].name).toBe('新名字')
  } finally {
    await store.dispose()
    await f.dispose()
  }
})

test('图片读取拒绝附件目录外文件及替换为符号链接的原图', async () => {
  const f = await fixture()
  const store = f.create()
  try {
    const outside = path.join(f.root, 'outside.png')
    await writeFile(outside, png)
    await expect(store.add({ ...f.candidate, artifact: { ...f.candidate.artifact, path: outside } })).rejects.toThrow(
      '附件目录',
    )
    await store.add(f.candidate)
    await rm(f.image)
    await symlink(outside, f.image)
    await expect(store.read('image')).rejects.toThrow('符号链接')
  } finally {
    await store.dispose()
    await f.dispose()
  }
})

test('并发收录不丢记录，游标在新增作品后不会重复旧页，损坏索引保持原样', async () => {
  const f = await fixture()
  let store = f.create()
  try {
    await Promise.all(
      ['a', 'b', 'c'].map((id) => store.add({ ...f.candidate, artifact: { ...f.candidate.artifact, id } })),
    )
    const first = await store.list({ limit: 2 })
    expect(first.items.map((item) => item.id)).toEqual(['c', 'b'])
    await store.add({
      ...f.candidate,
      createdAt: '2026-10-30T00:00:00.000Z',
      artifact: { ...f.candidate.artifact, id: 'new' },
    })
    expect((await store.list({ cursor: first.nextCursor })).items.map((item) => item.id)).toEqual(['a'])
    await store.dispose()
    await writeFile(f.options.file, '{broken')
    store = f.create()
    await expect(store.list()).rejects.toThrow('原文件已保留')
    await expect(store.add(f.candidate)).rejects.toThrow('原文件已保留')
    expect(await readFile(f.options.file, 'utf8')).toBe('{broken')
  } finally {
    await store.dispose()
    await f.dispose()
  }
})
