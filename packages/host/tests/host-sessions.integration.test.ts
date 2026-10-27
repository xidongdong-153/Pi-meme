import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { setTimeout as delay } from 'node:timers/promises'
import type { InstructionsSnapshot } from '@pi-meme/contracts/settings'
import type { SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import { setup } from './host-server-fixture'
import { SessionService } from '@pi-meme/workspace/server/session-service'
import { ProjectStore } from '@pi-meme/workspace/server/project-store'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'

test('读取与新建当前会话不扫描其他历史且返回稳定身份', async () => {
  const fixture = await setup()
  let sessions: ReturnType<typeof vi.spyOn> | undefined
  let projects: ReturnType<typeof vi.spyOn> | undefined
  try {
    const first = (await fixture.rpc('fast-selection', 'pi:snapshot')).result as Snapshot
    assert.ok(first.appSession?.sessionId)
    sessions = vi.spyOn(SessionService.prototype, 'getSnapshot').mockRejectedValue(new Error('无关历史不可读取'))
    projects = vi.spyOn(ProjectStore.prototype, 'list').mockRejectedValue(new Error('无关项目不可读取'))
    const snapshot = await fixture.rpc('fast-selection', 'pi:snapshot')
    assert.equal(snapshot.error, undefined)
    assert.equal((snapshot.result as Snapshot).appSession?.sessionId, first.appSession.sessionId)
    const created = await fixture.rpc('fast-selection', 'pi:new-session')
    assert.equal(created.error, undefined)
    const selection = created.result as SessionSelectionResult
    if (selection.cancelled) throw new Error('新建会话不应取消')
    assert.ok(selection.snapshot.appSession?.sessionId)
    assert.notEqual(selection.snapshot.appSession.sessionId, first.appSession.sessionId)
    const key = selection.snapshot.connection.sessionKey!
    const [left, right] = await Promise.all([
      fixture.server.host.control.sessionForRuntime(key),
      fixture.server.host.control.sessionForRuntime(key),
    ])
    assert.equal(left.sessionId, right.sessionId)
    assert.equal(left.sessionId, selection.snapshot.appSession.sessionId)
    assert.equal(sessions.mock.calls.length, 0)
    assert.equal(projects.mock.calls.length, 0)
  } finally {
    sessions?.mockRestore()
    projects?.mockRestore()
    await fixture.dispose()
  }
})

test('会话首屏分页与更早记录使用稳定游标，完整快照仍可读取', async () => {
  const fixture = await setup()
  try {
    const folder = path.join(createPiRuntimePaths(fixture.root).sessionsDirectory, 'paged-fixture')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'saved.jsonl')
    const timestamp = '2026-10-10T00:00:00Z'
    await writeFile(
      file,
      [
        { type: 'session', version: 3, id: 'paged', cwd: fixture.root, timestamp },
        ...Array.from({ length: 160 }, (_, index) => ({
          type: 'message',
          id: `entry-${index}`,
          parentId: index ? `entry-${index - 1}` : null,
          timestamp,
          message: index % 2 ? assistantMessage(`回复${index}`, index) : userMessage(`问题${index}`, index),
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    const response = await fetch(`${fixture.server.url}/api/rpc`, {
      method: 'POST',
      headers: { Cookie: fixture.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        clientId: 'paged-selection',
        method: 'pi:switch-session',
        args: [file, { limit: 60 }],
      }),
    })
    assert.match(response.headers.get('server-timing') ?? '', /host;dur=[\d.]+, serialize;dur=[\d.]+/)
    const envelope = (await response.json()) as { result: SessionSelectionResult; error?: unknown }
    assert.equal(envelope.error, undefined)
    const selection = envelope.result
    if (selection.cancelled) throw new Error('会话选择不应取消')
    assert.equal(selection.snapshot.messages.length, 60)
    assert.deepEqual(selection.snapshot.messagePage, { before: 'entry-100' })
    const older = await fixture.rpc('paged-selection', 'session:history', [
      selection.snapshot.connection.sessionKey,
      { limit: 60, before: 'entry-100' },
    ])
    assert.equal(older.error, undefined)
    const history = older.result as import('@pi-meme/contracts/sessions').SessionHistoryData
    assert.equal(history.messages.length, 60)
    assert.equal(history.messages[0].sourceEntry?.id, 'entry-40')
    assert.deepEqual(history.messagePage, { before: 'entry-40' })
    const full = (await fixture.rpc('paged-selection', 'pi:snapshot')).result as Snapshot
    assert.equal(full.messages.length, 160)
    assert.equal(full.messagePage, undefined)
  } finally {
    await fixture.dispose()
  }
})

test('历史正文搜索经真实HTTP路由返回摘要，不改变客户端当前会话', async () => {
  const fixture = await setup()
  try {
    const folder = path.join(createPiRuntimePaths(fixture.root).sessionsDirectory, 'search-fixture')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'saved.jsonl')
    await writeFile(
      file,
      [
        { type: 'session', id: 'saved', cwd: fixture.root },
        { type: 'message', message: { role: 'user', content: '标题里没有的正文关键字' } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    const before = await fixture.rpc('search-client', 'pi:connection')
    const result = await fixture.rpc('search-client', 'session:search', ['正文关键字', [file]])
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    assert.deepEqual(result.result, [{ path: file, excerpt: '标题里没有的正文关键字' }])
    const after = await fixture.rpc('search-client', 'pi:connection')
    assert.equal(
      (after.result as Snapshot['connection']).sessionKey,
      (before.result as Snapshot['connection']).sessionKey,
    )
  } finally {
    await fixture.dispose()
  }
})

test('两客户端选择不同项目不改变彼此快照、命令与 Git 目录', async () => {
  const fixture = await setup()
  try {
    const a = path.join(fixture.root, 'project-a')
    const b = path.join(fixture.root, 'project-b')
    await mkdir(a)
    await mkdir(b)
    await writeFile(path.join(a, 'AGENTS.md'), '客户端 A 的项目指令')
    await writeFile(path.join(b, 'AGENTS.md'), '客户端 B 的项目指令')
    const connections: string[] = []
    const unsubscribe = await fixture.server.host.subscribe('a', (event) => {
      if (event.type === 'connection') connections.push(event.value.cwd)
    })
    const [first, second] = await Promise.all([
      fixture.rpc('a', 'workspace:select', [{ kind: 'project', cwd: a }]),
      fixture.rpc('b', 'workspace:select', [{ kind: 'project', cwd: b }]),
    ])
    assert.equal(first.error, undefined, JSON.stringify(first.error))
    assert.equal(second.error, undefined, JSON.stringify(second.error))
    const left = first.result as SessionSelectionResult
    const right = second.result as SessionSelectionResult
    assert.equal(left.cancelled, false)
    assert.equal(right.cancelled, false)
    if (left.cancelled || right.cancelled) throw new Error('会话选择不应取消')
    assert.notEqual(left.snapshot.connection.sessionKey, right.snapshot.connection.sessionKey)
    const [leftSnapshot, rightSnapshot, leftGit, rightGit] = await Promise.all([
      fixture.rpc('a', 'pi:snapshot'),
      fixture.rpc('b', 'pi:snapshot'),
      fixture.rpc('a', 'git:snapshot'),
      fixture.rpc('b', 'git:snapshot'),
    ])
    assert.equal((leftSnapshot.result as Snapshot).connection.cwd, a)
    assert.equal((rightSnapshot.result as Snapshot).connection.cwd, b)
    assert.equal((leftGit.result as { cwd: string }).cwd, a)
    assert.equal((rightGit.result as { cwd: string }).cwd, b)
    const [leftInstructions, rightInstructions] = await Promise.all([
      fixture.rpc('a', 'settings:instructions'),
      fixture.rpc('b', 'settings:instructions'),
    ])
    assert.equal(leftInstructions.error, undefined)
    assert.equal(rightInstructions.error, undefined)
    assert.equal((leftInstructions.result as InstructionsSnapshot).entries[0].project?.content, '客户端 A 的项目指令')
    assert.equal((rightInstructions.result as InstructionsSnapshot).entries[0].project?.content, '客户端 B 的项目指令')
    assert.equal(connections.at(-1), a, '选择完成后通知该客户端的新项目目录')
    assert.equal(connections.includes(b), false)
    unsubscribe()
    const mismatch = await fixture.rpc(
      'a',
      'pi:abort',
      [left.snapshot.connection.sessionKey],
      right.snapshot.connection.sessionKey,
    )
    assert.match(mismatch.error!.message, /匹配的 sessionId/)
  } finally {
    await fixture.dispose()
  }
})

test('目录选择可恢复具体无项目会话，父目录和嵌套目录不能被选择或登记为项目', async () => {
  const fixture = await setup()
  try {
    const selected = await fixture.rpc('directory', 'workspace:select', [{ kind: 'standalone' }])
    const result = selected.result as SessionSelectionResult
    assert.equal(result.cancelled, false)
    if (result.cancelled) throw new Error('无项目会话选择不应取消')
    const standalone = result.snapshot.connection.cwd
    const nested = path.join(standalone, 'child')
    await mkdir(nested)
    await fixture.rpc('directory', 'pi:new-session')
    for (const target of [path.dirname(standalone), nested]) {
      const invalid = await fixture.rpc('directory', 'pi:directory', [target])
      assert.match(invalid.error!.message, /请选择具体的无项目会话目录/)
    }
    const restored = (await fixture.rpc('directory', 'pi:directory', [standalone])).result as SessionSelectionResult
    assert.equal(restored.cancelled, false)
    if (restored.cancelled) throw new Error('已有无项目会话目录选择不应取消')
    assert.equal(restored.snapshot.connection.cwd, standalone)
    assert.equal(restored.snapshot.connection.workspaceKind, 'standalone')
    assert.equal(((await fixture.rpc('directory', 'pi:snapshot')).result as Snapshot).connection.cwd, standalone)
    const register = await fixture.rpc('directory', 'project:register', [standalone])
    assert.match(register.error!.message, /不能将无项目会话目录登记为项目/)
    const project = path.join(fixture.root, 'directory-project')
    await mkdir(project)
    const projectSelection = (await fixture.rpc('directory', 'pi:directory', [project]))
      .result as SessionSelectionResult
    assert.equal(projectSelection.cancelled, false)
    if (projectSelection.cancelled) throw new Error('项目目录选择不应取消')
    assert.equal(projectSelection.snapshot.connection.cwd, project)
    assert.equal(projectSelection.snapshot.connection.workspaceKind, 'project')
  } finally {
    await fixture.dispose()
  }
})

test('一端分叉后重取快照仍选中分叉，另一端保留原会话且重复消息只执行一次', async () => {
  const fixture = await setup(true)
  try {
    const first = await fixture.rpc('a', 'pi:snapshot')
    const key = (first.result as Snapshot).connection.sessionKey!
    assert.ok((first.result as Snapshot).models.length)
    await fixture.rpc('a', 'pi:access-mode', [key, 'full-access'], key)
    const send = await fixture.rpc('a', 'pi:prompt', [key, '第一轮'], key)
    assert.equal(send.error, undefined)
    let original!: Snapshot
    for (let count = 0; count < 100; count++) {
      original = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
      if (!original.state.isStreaming && original.messages.some((message) => message.role === 'assistant')) break
      await delay(50)
    }
    const path = original.connection.sessionFile!
    assert.ok(path)
    const joined = await fixture.rpc('b', 'pi:switch-session', [path])
    assert.equal(joined.error, undefined)
    assert.equal(
      (joined.result as Exclude<SessionSelectionResult, { cancelled: true }>).snapshot.connection.sessionKey,
      key,
    )
    const timestamp = original.messages.find((message) => message.role === 'user')!.timestamp
    const forked = await fixture.rpc('a', 'pi:fork-reply', [key, timestamp], key)
    assert.equal(forked.error, undefined)
    const fork = forked.result as Exclude<SessionSelectionResult, { cancelled: true }>
    assert.equal(fork.cancelled, false)
    assert.notEqual(fork.snapshot.connection.sessionKey, key)
    assert.equal(
      ((await fixture.rpc('a', 'pi:snapshot')).result as Snapshot).connection.sessionKey,
      fork.snapshot.connection.sessionKey,
    )
    assert.equal(
      ((await fixture.rpc('a', 'pi:connection')).result as Snapshot['connection']).sessionKey,
      fork.snapshot.connection.sessionKey,
    )
    assert.equal(((await fixture.rpc('b', 'pi:snapshot')).result as Snapshot).connection.sessionKey, key)
    const events: import('@pi-meme/contracts/host').HostEvent[] = []
    const unsubscribe = await fixture.server.host.subscribe('b', (event) => events.push(event))
    assert.equal((await fixture.rpc('b', 'pi:access-mode', [key, 'read-only'], key)).error, undefined)
    assert.equal((await fixture.rpc('b', 'pi:access-mode', [key, 'full-access'], key)).error, undefined)
    const requests = await Promise.all([
      fixture.rpc('b', 'pi:prompt', [key, '后台第二轮'], key, 'same-prompt'),
      fixture.rpc('b', 'pi:prompt', [key, '后台第二轮'], key, 'same-prompt'),
    ])
    assert.equal(requests[0].error, undefined)
    assert.deepEqual(requests[0], requests[1])
    for (
      let count = 0;
      count < 100 && !events.some((event) => event.type === 'event' && event.value.event.type === 'agent_settled');
      count++
    )
      await delay(50)
    assert.ok(
      events.some(
        (event) =>
          event.type === 'event' && event.value.sessionKey === key && event.value.event.type === 'message_update',
      ),
    )
    assert.ok(events.some((event) => event.type === 'connection' && event.value.sessionKey === key))
    const after = (await fixture.rpc('b', 'pi:snapshot')).result as Snapshot
    assert.equal(
      after.messages.filter(
        (message) => message.role === 'user' && JSON.stringify(message.content).includes('后台第二轮'),
      ).length,
      1,
    )
    assert.equal(
      ((await fixture.rpc('a', 'pi:snapshot')).result as Snapshot).connection.sessionKey,
      fork.snapshot.connection.sessionKey,
    )
    unsubscribe()
  } finally {
    await fixture.dispose()
  }
})
