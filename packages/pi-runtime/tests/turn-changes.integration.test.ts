import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { SdkSession } from '../src/sdk/session'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { loadPiSdk } from '../src/sdk/load'
import { createTurnChangesExtension } from '../src/extensions/turn-changes'
import { generateFilePatch } from '../src/file-patch'
import {
  recordFileChange,
  readTurnChangeSummaries,
  turnChangeCacheStats,
  readTurnChanges,
  readTurnChangeFile,
  undoTurnChanges,
} from '../src/turn-change-store'

test('整段替换 patch 与 SDK 一致，覆盖换行、空文件和相同行边界', async () => {
  const sdk = await loadPiSdk()
  const samples = ['', '旧\n', '新\n', '旧', '新', '\n', '旧\r\n', '新\r\n', '共同\n旧\n', '共同\n新\n']
  for (const before of samples)
    for (const after of samples)
      assert.equal(
        generateFilePatch(sdk, '测试 file.txt', before, after),
        sdk.generateUnifiedPatch('测试 file.txt', before, after),
      )
  const before = '旧内容\n'.repeat(1500)
  const after = '新内容\n'.repeat(1500)
  const patch = generateFilePatch(
    {
      generateUnifiedPatch: () => {
        throw new Error('整段替换不能进入差异搜索')
      },
    },
    'large.txt',
    before,
    after,
  )
  assert.equal(patch, sdk.generateUnifiedPatch('large.txt', before, after))
})

test('真实会话的 codemode 嵌套写入按用户 entry ID 保存，恢复后仍能读取', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'turn-session-')))
  const fake = await useFakeAgent(directory, {
    reply: (_body, index) =>
      index === 1
        ? {
            tool: {
              name: 'codemode',
              arguments: JSON.stringify({ code: "await tools.write({path:'nested.txt',content:'hello\\n'});" }),
            },
          }
        : '完成',
  })
  const saved: import('@pi-meme/contracts/desktop').DesktopEvent[] = []
  const session = new SdkSession(
    directory,
    {
      connection: () => {},
      error: () => {},
      event: (event) => {
        saved.push(event)
      },
    },
    fake.runtimePaths,
    fake.credentials,
  )
  try {
    session.configureAccess('full-access')
    session.start(directory)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('创建文件')
    const deadline = Date.now() + 10000
    while ((await session.snapshot()).state.isStreaming) {
      if (Date.now() > deadline) throw new Error('等待会话超时')
      await delay(10)
    }
    const snapshot = await session.snapshot()
    const user = snapshot.messages.find((message) => message.role === 'user')!
    assert.ok(user.sourceEntry?.id)
    const sessionFile = session.getActiveSession().sessionFile!
    await session.stopAndWait()
    const [turn] = await readTurnChanges(sessionFile, [user.sourceEntry.id])
    assert.ok(turn, JSON.stringify(snapshot.messages))
    assert.ok(saved.some((value) => value.event.type === 'session_saved'))
    assert.ok(
      saved.some((value) => value.event.type === 'turn_changes_update' && value.event.entryId === user.sourceEntry!.id),
    )
    assert.equal(turn.files[0].path, 'nested.txt')
    assert.equal(turn.insertions, 1)
    await undoTurnChanges(sessionFile, user.sourceEntry.id, directory, false)
    await assert.rejects(readFile(path.join(directory, 'nested.txt')), { code: 'ENOENT' })
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('文件工具记录覆盖、新建与嵌套调用，持久化净差异并安全撤销', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'turn-changes-')))
  const sessionFile = path.join(directory, 'session.jsonl')
  const sdk = await loadPiSdk()
  const tools = new Map<string, ToolDefinition>()
  let resultHook: (event: { toolCallId: string; isError: boolean; details: unknown }) => unknown
  const context = {
    cwd: directory,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => [{ id: 'user-one', type: 'message', message: { role: 'user' } }],
    },
  } as unknown as ExtensionToolContext
  const extension = createTurnChangesExtension(sdk, directory)
  assert.ok(typeof extension !== 'function')
  await extension.factory({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (_name: string, hook: typeof resultHook) => {
      resultHook = hook
    },
  } as unknown as ExtensionAPI)
  const execute = async (name: string, id: string, input: unknown) => {
    const result = await tools.get(name)!.execute(id, input, undefined, undefined, context)
    return resultHook!({ toolCallId: id, isError: false, details: result.details }) as {
      details: { created: boolean; patch: string }
    }
  }
  try {
    await writeFile(path.join(directory, 'existing.ts'), '用户原有修改\n')
    const first = await execute('write', 'outer/1', { path: 'existing.ts', content: '第一版\n' })
    assert.equal(first.details.created, false)
    const created = await execute('write', 'outer/2', { path: 'new.ts', content: '新文件\n' })
    assert.equal(created.details.created, true)
    await execute('edit', 'direct', { path: 'existing.ts', edits: [{ oldText: '第一版', newText: '第二版' }] })
    const [turn] = await readTurnChanges(sessionFile, ['user-one'])
    assert.equal(turn.files.length, 2)
    assert.equal(turn.insertions, 2)
    assert.equal(turn.deletions, 1)
    assert.match(turn.files[0].patch, /用户原有修改/)
    assert.doesNotMatch(turn.files[0].patch, /第一版/)
    await writeFile(path.join(directory, 'new.ts'), '用户后续修改\n')
    const history = await readTurnChangeFile(sessionFile, 'user-one', 'new.ts')
    assert.equal(history.before, '')
    assert.equal(history.after, '新文件\n')
    await assert.rejects(readTurnChangeFile(sessionFile, 'user-one', '../outside'), /历史内容/)
    await assert.rejects(undoTurnChanges(sessionFile, 'user-one', directory, false), /后续修改/)
    assert.equal(await readFile(path.join(directory, 'existing.ts'), 'utf8'), '第二版\n')
    await writeFile(path.join(directory, 'new.ts'), '新文件\n')
    await undoTurnChanges(sessionFile, 'user-one', directory, false)
    assert.equal(await readFile(path.join(directory, 'existing.ts'), 'utf8'), '用户原有修改\n')
    await assert.rejects(readFile(path.join(directory, 'new.ts')), { code: 'ENOENT' })
    const undone = (await readTurnChanges(sessionFile, ['user-one']))[0]
    assert.equal(undone.undone, true)
    assert.equal(undone.files.find((file) => file.path === 'new.ts')?.canOpen, false)
    await undoTurnChanges(sessionFile, 'user-one', directory, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('摘要不传 patch，并发读取与文件详情复用计算，更新只计算变动文件', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'turn-cache-')))
  const session = path.join(directory, 'session.jsonl')
  const file = path.join(directory, 'a.txt')
  const second = path.join(directory, 'b.txt')
  try {
    await writeFile(file, 'one\n')
    await writeFile(second, 'two\n')
    await recordFileChange(session, 'u', directory, file, null, Buffer.from('one\n'))
    await recordFileChange(session, 'u', directory, second, null, Buffer.from('two\n'))
    const before = turnChangeCacheStats()
    const [summary, full] = await Promise.all([
      readTurnChangeSummaries(session, ['u']),
      readTurnChanges(session, ['u']),
    ])
    assert.equal(turnChangeCacheStats().patchComputations - before.patchComputations, 2)
    assert.equal(turnChangeCacheStats().recordReads - before.recordReads, 1)
    assert.equal('patch' in summary[0].files[0], false)
    assert.equal(summary[0].insertions, full[0].insertions)
    assert.ok(summary[0].revision)
    await readTurnChangeFile(session, 'u', 'a.txt')
    for (let i = 0; i < 10; i++) await readTurnChangeSummaries(session, ['u'])
    assert.equal(turnChangeCacheStats().patchComputations - before.patchComputations, 2)
    await writeFile(file, 'changed\n')
    await recordFileChange(session, 'u', directory, file, Buffer.from('one\n'), Buffer.from('changed\n'))
    const updated = await readTurnChangeSummaries(session, ['u'])
    assert.notEqual(updated[0].revision, summary[0].revision)
    assert.equal(turnChangeCacheStats().patchComputations - before.patchComputations, 3)
    assert.match((await readTurnChangeFile(session, 'u', 'a.txt')).patch, /changed/)
    // 撤销读取当前磁盘内容，不能信任刚命中的缓存。
    await writeFile(file, 'external\n')
    await assert.rejects(undoTurnChanges(session, 'u', directory, false), /后续修改/)
    assert.ok(turnChangeCacheStats().bytes <= turnChangeCacheStats().budget)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
