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
import { readTurnChanges, undoTurnChanges } from '../src/turn-change-store'

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
  const session = new SdkSession(
    directory,
    { connection: () => {}, error: () => {}, event: () => {} },
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
    await assert.rejects(undoTurnChanges(sessionFile, 'user-one', directory, false), /后续修改/)
    assert.equal(await readFile(path.join(directory, 'existing.ts'), 'utf8'), '第二版\n')
    await writeFile(path.join(directory, 'new.ts'), '新文件\n')
    await undoTurnChanges(sessionFile, 'user-one', directory, false)
    assert.equal(await readFile(path.join(directory, 'existing.ts'), 'utf8'), '用户原有修改\n')
    await assert.rejects(readFile(path.join(directory, 'new.ts')), { code: 'ENOENT' })
    assert.equal((await readTurnChanges(sessionFile, ['user-one']))[0].undone, true)
    await undoTurnChanges(sessionFile, 'user-one', directory, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
