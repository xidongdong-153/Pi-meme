import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HostApi, FilePreview, WorkspaceRef } from '@pi-meme/contracts/app-host'
import { FileStore, fileDirty } from '../src/ui/file-store'

const root = { hostId: 'host', sessionId: 'one' }
function fixture(files: Partial<HostApi['files']>, operations: string[] = ['preview', 'search', 'write']) {
  const host = {
    capabilities: async () => ({ apiVersion: 2, hostId: 'host', features: ['files'], fileOperations: operations }),
    files,
  } as HostApi
  return new FileStore(host)
}
function preview(path: string, content = '原文'): FilePreview {
  return {
    kind: 'text',
    relativePath: path,
    content,
    revision: 'old',
  }
}

test('迟到读取不覆盖后选文件，同路径草稿按 Host 与会话隔离，关闭视图后仍可读取', async () => {
  let resolve!: (value: FilePreview) => void
  const store = fixture({
    preview: async (_root, path) =>
      path === 'first.ts'
        ? new Promise((done) => {
            resolve = done
          })
        : preview(path),
  })
  const first = store.select(root, 'first.ts')
  await Promise.resolve()
  await Promise.resolve()
  await store.select(root, 'second.ts')
  resolve(preview('first.ts', '迟到内容'))
  await first
  store.edit(root, '当前草稿')
  assert.equal(store.state(root).selected, 'second.ts')
  assert.equal(store.state(root).draft, '当前草稿')
  for (const other of [
    { ...root, sessionId: 'two' },
    { ...root, hostId: 'other' },
  ]) {
    await store.select(other, 'second.ts')
    assert.equal(store.state(other).draft, '原文')
  }
  const stop = store.subscribe(() => {})
  stop()
  assert.equal(store.state(root).draft, '当前草稿')
  assert.equal(store.hasDirty(), true)
  store.dispose()
})

test('保存期间继续编辑保留新草稿，成功仅更新已保存正文与修订', async () => {
  let finish!: (value: { revision: string }) => void
  let submitted: unknown
  const store = fixture({
    preview: async (_root, path) => preview(path),
    write: async (_root, input) => {
      submitted = input
      return new Promise((done) => {
        finish = done
      })
    },
  })
  await store.select(root, 'file.ts')
  store.edit(root, '提交的正文')
  const saving = store.save(root)
  store.edit(root, '保存中继续编辑')
  finish({ revision: 'new' })
  assert.equal(await saving, true)
  assert.deepEqual(submitted, { relativePath: 'file.ts', content: '提交的正文', revision: 'old' })
  assert.equal(store.state(root).draft, '保存中继续编辑')
  assert.equal(store.state(root).saved, '提交的正文')
  assert.equal(fileDirty(store.state(root)), true)
  const current = store.state(root).preview
  assert.equal(current?.kind === 'text' && current.revision, 'new')
})

test('保存冲突保留草稿，无改动时不写盘，旧 Host 保持只读且不调用新接口', async () => {
  let writes = 0
  const store = fixture({
    preview: async (_root, path) => preview(path),
    write: async () => {
      writes++
      throw new Error('文件已被其他程序修改')
    },
  })
  await store.select(root, 'file.ts')
  assert.equal(await store.save(root), true)
  assert.equal(writes, 0)
  store.edit(root, '草稿')
  assert.equal(await store.save(root), false)
  assert.equal(store.state(root).draft, '草稿')
  assert.match(store.state(root).error, /其他程序/)
  const legacy = fixture({ read: async (_root, path) => ({ relativePath: path, content: '旧 Host' }) }, [])
  await legacy.select(root, 'file.ts')
  assert.equal(legacy.state(root).draft, '旧 Host')
  assert.equal(legacy.canWrite(legacy.state(root)), false)
  assert.equal(await legacy.save(root), false)
})

test('旧搜索结果不能覆盖新查询，分页保留原匹配项', async () => {
  let finish!: (value: { entries: [] }) => void
  const calls: unknown[] = []
  const store = fixture({
    search: async (_root: WorkspaceRef, input) => {
      calls.push(input)
      if (input.query === 'old')
        return new Promise((done) => {
          finish = done
        })
      return {
        entries: [{ name: 'new.ts', relativePath: input.cursor ? 'other/new.ts' : 'new.ts', kind: 'file', size: 1 }],
        nextCursor: input.cursor ? undefined : 'next',
      }
    },
  })
  const old = store.search(root, 'old')
  await Promise.resolve()
  await Promise.resolve()
  await store.search(root, 'new')
  finish({ entries: [] })
  await old
  await store.search(root, 'new', true)
  assert.equal(store.state(root).matches.length, 2)
  assert.deepEqual(calls.at(-1), { query: 'new', cursor: 'next' })
})
