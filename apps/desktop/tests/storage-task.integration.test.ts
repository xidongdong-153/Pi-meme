import assert from 'node:assert/strict'
import { test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { lockDataRoot, relocatedMarker } from '@pi-meme/host/data-root'
import { writeJson } from '@pi-meme/host/storage/files'
import { executeStorageTask } from '../src/main/storage/task'
import { readStoragePreferences, writeStoragePreferences, type StorageJob } from '../src/main/storage/preferences'

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-meme-storage-task-')))
  const source = path.join(directory, 'source')
  const target = path.join(directory, 'target')
  const anchor = path.join(directory, 'desktop')
  await Promise.all([source, target, anchor].map((folder) => mkdir(folder)))
  await writeFile(path.join(source, 'host-id'), 'fixture-host')
  const file = path.join(anchor, 'storage-location.json')
  const job: StorageJob = { id: randomUUID(), kind: 'migrate', hostId: 'fixture-host', source, target }
  await writeStoragePreferences(file, { version: 1, dataRoot: source, backupPaths: [], pending: job })
  return {
    directory,
    source,
    target,
    anchor,
    file,
    job,
    run: () => executeStorageTask({ type: 'run', file, anchor, job }, () => {}),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

test('中断任务的旧锁尚未释放时保留 pending，重试后完成迁移', async () => {
  const f = await fixture()
  try {
    await writeJson(path.join(f.source, relocatedMarker), { id: f.job.id, target: f.target, status: 'maintaining' })
    const release = await lockDataRoot(f.source)
    try {
      await assert.rejects(f.run(), /已有 Host/)
    } finally {
      await release()
    }
    const blocked = await readStoragePreferences(f.file)
    assert.equal(blocked.pending?.id, f.job.id)
    assert.match(blocked.lastError!, /已有 Host/)
    await f.run()
    const saved = await readStoragePreferences(f.file)
    assert.equal(saved.dataRoot, f.target)
    assert.equal(saved.pending, undefined)
    assert.deepEqual(saved.backupPaths, [f.source])
  } finally {
    await f.dispose()
  }
})

test('复制开始前目标被写入其他文件，不切换目录且保留文件', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.target, 'user-file'), 'keep')
    await assert.rejects(f.run(), /不为空/)
    const saved = await readStoragePreferences(f.file)
    assert.equal(saved.dataRoot, f.source)
    assert.equal(saved.pending, undefined)
    assert.equal(saved.failedJob?.id, f.job.id)
    assert.equal(await readFile(path.join(f.target, 'user-file'), 'utf8'), 'keep')
  } finally {
    await f.dispose()
  }
})

test('待执行任务被替换后拒绝旧任务，且不改写最新定位', async () => {
  const f = await fixture()
  try {
    const replacement = { ...f.job, id: randomUUID() }
    await writeStoragePreferences(f.file, { version: 1, dataRoot: f.source, backupPaths: [], pending: replacement })
    await assert.rejects(f.run(), /已变化/)
    assert.equal((await readStoragePreferences(f.file)).pending?.id, replacement.id)
  } finally {
    await f.dispose()
  }
})
