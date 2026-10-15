import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { startHostServer } from '../src/server'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { lockDataRoot } from '../src/data-root'
import type { HostRpcResponse } from '@pi-meme/contracts/host'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import type { InstructionsSnapshot } from '@pi-meme/contracts/settings'
import type { SessionSelectionResult, Snapshot, WorkspaceDeletionResult } from '@pi-meme/contracts/desktop'
import type { PiSessionsSnapshot } from '@pi-meme/contracts/sessions'

async function setup(fake = false, clientGraceMs?: number) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-meme-host-test-')))
  const modelTools: string[][] = []
  const agent = fake
    ? await useFakeAgent(root, {
        reply: (body: { tools?: Array<{ function?: { name?: string } }> }) => {
          modelTools.push((body.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])))
          return { text: '假模型回复', delayMs: 1000 }
        },
      })
    : undefined
  const server = await startHostServer({
    dataRoot: agent ? path.join(root, 'userData') : root,
    credentials: agent?.credentials ?? new MemoryCredentialStorage(),
    token: 'test-token',
    clientGraceMs,
  })
  const auth = await fetch(`${server.url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test-token' }),
  })
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]
  const rpc = async (
    clientId: string,
    method: string,
    args: unknown[] = [],
    sessionId?: string,
    requestId: string = crypto.randomUUID(),
  ) => {
    const response = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, clientId, hostId: server.host.hostId, sessionId, method, args }),
    })
    return (await response.json()) as HostRpcResponse
  }
  return {
    root,
    modelTools,
    server,
    cookie,
    rpc,
    dispose: async () => {
      await server.dispose()
      await agent?.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function selectAgentPlugins(
  host: Awaited<ReturnType<typeof startHostServer>>['host'],
  key: string,
  ids: string[],
) {
  const ref = await host.control.sessionForRuntime(key)
  await host.app.sessions.configure(ref, { agentPlugins: ids }, { idempotencyKey: crypto.randomUUID() })
}

async function installAgentFixture(
  host: Awaited<ReturnType<typeof startHostServer>>['host'],
  directory: string,
  id: string,
  content: string,
) {
  await mkdir(path.join(directory, 'dist'), { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: id, version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'dist/agent.js' } }),
  )
  await writeFile(path.join(directory, 'dist/agent.js'), content)
  await host.plugins.loadDirectory(directory)
}

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

for (const method of ['session:delete', 'project:remove']) {
  test(`${method} 清理当前会话后保存新选择，后续列表和快照可读取`, async () => {
    const fixture = await setup()
    try {
      const cwd = path.join(fixture.root, 'delete-project')
      const directory = path.join(fixture.root, 'sessions', 'delete-test')
      const file = path.join(directory, 'saved.jsonl')
      await mkdir(cwd)
      await mkdir(directory, { recursive: true })
      await fixture.rpc('delete', 'project:register', [cwd])
      await writeFile(
        file,
        `${[
          { type: 'session', version: 3, id: 'saved', cwd, timestamp: '2026-10-10T00:00:00Z' },
          {
            type: 'message',
            id: 'user',
            parentId: null,
            timestamp: '2026-10-10T00:00:01Z',
            message: { role: 'user', content: 'hello', timestamp: 1 },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n')}\n`,
      )
      const selected = (await fixture.rpc('delete', 'pi:switch-session', [file])).result as SessionSelectionResult
      if (selected.cancelled) throw new Error('会话选择不应取消')
      const key = selected.snapshot.connection.sessionKey!
      await fixture.rpc('delete', 'settings:toggle-pin', [file], key)
      assert.equal(
        ((await fixture.rpc('delete', 'pi:sessions', [], key)).result as PiSessionsSnapshot).recents.length,
        1,
      )
      const response = await fixture.rpc('delete', method, method === 'session:delete' ? [file] : [cwd, [file]], key)
      assert.equal(response.error, undefined)
      const result = response.result as WorkspaceDeletionResult
      assert.deepEqual(result.errors, [])
      assert.deepEqual(result.deletedPaths, [file])
      assert.ok(result.deletedKeys.includes(key))
      if (!result.selection || result.selection.cancelled) throw new Error('删除后应返回新会话')
      const replacement = result.selection.snapshot
      assert.notEqual(replacement.connection.sessionKey, key)
      assert.deepEqual(replacement.messages, [])
      const current = await fixture.rpc('delete', 'pi:snapshot')
      assert.equal(current.error, undefined)
      assert.equal((current.result as Snapshot).connection.sessionKey, replacement.connection.sessionKey)
      const listing = await fixture.rpc('delete', 'pi:sessions')
      assert.equal(listing.error, undefined)
      const sessions = listing.result as PiSessionsSnapshot
      assert.deepEqual(sessions.recents, [])
      assert.deepEqual(sessions.standaloneSessions, [])
      assert.deepEqual(sessions.pinnedPaths, [])
      assert.ok(sessions.projects.every((project) => project.sessions.every((session) => session.path !== file)))
      assert.deepEqual(replacement.uiPlugins, [])
    } finally {
      await fixture.dispose()
    }
  })
}

test('HttpOnly 认证、一次性握手、未认证 WebSocket与远程HTTP拒绝', async () => {
  const fixture = await setup()
  try {
    assert.equal((await fetch(`${fixture.server.url}/api/rpc`, { method: 'POST' })).status, 401)
    const ticket = fixture.server.createBootstrapTicket()
    const auth = () =>
      fetch(`${fixture.server.url}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ticket }),
      })
    const first = await auth()
    assert.equal(first.status, 200)
    assert.match(first.headers.get('set-cookie')!, /HttpOnly/)
    assert.equal((await auth()).status, 401)
    const socket = new WebSocket(`${fixture.server.url.replace('http:', 'ws:')}/api/events?clientId=a`)
    await new Promise<void>((resolve) => socket.once('error', () => resolve()))
    const result = await fixture.rpc('a', 'pi:snapshot')
    assert.equal(result.hostId, fixture.server.host.hostId)
    await assert.rejects(startHostServer({ hostname: '0.0.0.0' }), /HTTPS/)
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

test('AppAgent 命令按会话启用，插件接口不能停用内置资源模块', async () => {
  const fixture = await setup(true)
  try {
    const pluginId = 'command-fixture'
    await installAgentFixture(
      fixture.server.host,
      path.join(fixture.root, pluginId),
      pluginId,
      `export function activate(context) { context.commands.register({ name: 'native-resource', description: '应用命令', execute: async () => {} }) }\n`,
    )
    const initial = (await fixture.rpc('resource', 'pi:snapshot')).result as Snapshot
    const key = initial.connection.sessionKey!
    await selectAgentPlugins(fixture.server.host, key, [pluginId])
    assert.equal((await fixture.rpc('resource', 'pi:access-mode', [key, 'full-access'], key)).error, undefined)
    assert.equal((await fixture.rpc('resource', 'pi:prompt', [key, '资源扫描', [], []], key)).error, undefined)
    const commands = (await fixture.rpc('resource', 'pi:commands', [], key)).result as Array<{ name: string }>
    assert.ok(commands.some((command) => command.name === 'native-resource'))
    assert.equal(((await fixture.rpc('resource', 'pi:snapshot', [], key)).result as Snapshot).extensionError, undefined)
    assert.match(
      (await fixture.rpc('resource', 'plugins:disable', ['@pi-meme/resources'])).error?.message ?? '',
      /内置模块/,
    )
    for (let count = 0; count < 200; count++) {
      if (((await fixture.rpc('resource', 'pi:snapshot', [], key)).result as Snapshot).agent?.status === 'completed')
        break
      await delay(25)
    }
    assert.equal(
      (await fixture.rpc('resource', 'pi:prompt', [key, '拒绝停用后继续运行', [], []], key)).error,
      undefined,
    )
    const commandsAfter = (await fixture.rpc('resource', 'pi:commands', [], key)).result as Array<{ name: string }>
    assert.ok(commandsAfter.some((command) => command.name === 'native-resource'))
  } finally {
    await fixture.dispose()
  }
})

test('同地址新 Host 的插件入口与相对子模块都使用新的实例路径', async () => {
  const fixture = await setup()
  let restarted: Awaited<ReturnType<typeof startHostServer>> | undefined
  try {
    const directory = path.join(fixture.root, 'relative-ui')
    await mkdir(path.join(directory, 'dist/ui'), { recursive: true })
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'relative-ui', version: '1.0.0', piMeme: { sdkVersion: 2, ui: 'dist/ui/entry.js' } }),
    )
    await writeFile(
      path.join(directory, 'dist/ui/entry.js'),
      `import { text } from './child.js'; export const label = text\n`,
    )
    await writeFile(path.join(directory, 'dist/ui/child.js'), `export const text = '第一版'\n`)
    await fixture.server.host.plugins.loadDirectory(directory)
    const descriptors = (await fixture.rpc('a', 'plugins:list')).result as Array<{
      id: string
      generation: number
      ui?: string
    }>
    const first = descriptors.find((descriptor) => descriptor.id === 'relative-ui')!
    const firstChild = new URL('./child.js', new URL(first.ui!, fixture.server.url))
    assert.match(await (await fetch(firstChild, { headers: { Cookie: fixture.cookie } })).text(), /第一版/)
    const port = Number(new URL(fixture.server.url).port)
    await fixture.server.dispose()
    await writeFile(path.join(directory, 'dist/ui/child.js'), `export const text = '第二版'\n`)
    restarted = await startHostServer({
      dataRoot: path.join(fixture.root, 'restarted'),
      port,
      token: 'new-token',
      credentials: new MemoryCredentialStorage(),
    })
    await restarted.host.plugins.loadDirectory(directory)
    const auth = await fetch(`${restarted.url}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'new-token' }),
    })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]
    const response = await restarted.host.rpc({ requestId: 'ui', clientId: 'b', method: 'plugins:list', args: [] })
    const second = (response.result as typeof descriptors).find((descriptor) => descriptor.id === 'relative-ui')!
    assert.equal(first.generation, second.generation, '不同 Host 可重复相同插件代次')
    const secondChild = new URL('./child.js', new URL(second.ui!, restarted.url))
    assert.notEqual(secondChild.href, firstChild.href)
    assert.match(await (await fetch(secondChild, { headers: { Cookie: cookie } })).text(), /第二版/)
    assert.equal((await fetch(firstChild, { headers: { Cookie: cookie } })).status, 404)
  } finally {
    await restarted?.dispose()
    await fixture.dispose()
  }
})

test('内置交互不能被停用，弹框仍能回答，基础 UI 始终可用', async () => {
  const fixture = await setup(true)
  let pending: Promise<HostRpcResponse> | undefined
  try {
    const pluginId = 'interaction-fixture'
    await installAgentFixture(
      fixture.server.host,
      path.join(fixture.root, pluginId),
      pluginId,
      `export function activate(context) { context.commands.register({ name: 'lease-question', description: '交互验收', execute: async (_args, execution) => { await context.interaction.request([{ id: 'confirm', question: '请确认', options: [{ label: '确认' }, { label: '取消' }] }], execution.signal) } }); context.commands.register({ name: 'ui-availability', description: '检查交互', execute: async () => { context.interaction.notify('交互可用') } }) }\n`,
    )
    const initial = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
    const key = initial.connection.sessionKey!
    await selectAgentPlugins(fixture.server.host, key, [pluginId])
    await fixture.rpc('a', 'pi:access-mode', [key, 'full-access'], key)
    pending = fixture.rpc('a', 'pi:prompt', [key, '/lease-question', [], []], key)
    let id: string | undefined
    for (let count = 0; count < 200 && !id; count++) {
      const snapshot = (await fixture.rpc('b', 'pi:snapshot', [], key)).result as Snapshot
      const request = snapshot.events
        ?.map((value) => value.event)
        .find((event) => event.type === 'extension_ui_request' && event.method === 'questions')
      if (request?.type === 'extension_ui_request') id = request.id
      if (!id) await delay(25)
    }
    assert.ok(id)
    const disabling = await fixture.rpc('b', 'plugins:disable', ['@pi-meme/interaction'], key)
    assert.match(disabling.error?.message ?? '', /内置模块/)
    const oldSnapshot = (await fixture.rpc('a', 'pi:snapshot', [], key)).result as Snapshot
    assert.equal(
      oldSnapshot.uiPlugins?.some((descriptor) => descriptor.id === '@pi-meme/interaction'),
      false,
    )
    const git = await fixture.rpc('b', 'plugins:disable', ['@pi-meme/git'], key)
    assert.match(git.error?.message ?? '', /内置模块/)
    const invalid = await fixture.rpc('b', 'pi:extension-ui-response', [key, id, { value: '无效确认' }], key)
    assert.ok(invalid.error)
    const answers = await Promise.all([
      fixture.rpc('a', 'pi:extension-ui-response', [key, id, { answers: [{ id: 'confirm', value: '确认' }] }], key),
      fixture.rpc('b', 'pi:extension-ui-response', [key, id, { answers: [{ id: 'confirm', value: '取消' }] }], key),
    ])
    assert.equal(answers.filter((answer) => !answer.error).length, 1)
    assert.equal((await pending).error, undefined)
    pending = undefined
    const next = await fixture.rpc('a', 'pi:prompt', [key, '/ui-availability', [], []], key)
    assert.equal(next.error, undefined)
    const snapshot = (await fixture.rpc('a', 'pi:snapshot', [], key)).result as Snapshot
    assert.equal(
      snapshot.events?.some(
        (value) => value.event.type === 'extension_ui_request' && value.event.method === 'questions',
      ),
      false,
    )
  } finally {
    await fixture.server.host.pi.stopAndWait()
    await pending?.catch(() => {})
    await fixture.dispose()
  }
})

test('并发启动只有一个 Host 取得数据目录写锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-lock-test-'))
  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => lockDataRoot(root)))
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled',
    )
    assert.equal(acquired.length, 1)
    await acquired[0].value()
    const unlock = await lockDataRoot(root)
    await unlock()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 关闭等待凭据落盘，期间不能释放数据目录写锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-close-test-'))
  let closingCredentials = false
  let finish!: () => void
  let flushing!: () => void
  const started = new Promise<void>((resolve) => {
    flushing = resolve
  })
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const credentials = Object.assign(new MemoryCredentialStorage(), {
    flush: async () => {
      if (!closingCredentials) return
      flushing()
      await pending
    },
  })
  const server = await startHostServer({ dataRoot: root, credentials })
  try {
    closingCredentials = true
    const closing = server.dispose()
    await started
    await assert.rejects(lockDataRoot(root), /已有 Host/)
    finish()
    await closing
    const unlock = await lockDataRoot(root)
    await unlock()
  } finally {
    finish()
    await server.dispose()
    await rm(root, { recursive: true, force: true })
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

test('运行中安装与卸载 Agent 插件，旧任务保持原工具，新任务加载新工具集合', { timeout: 30000 }, async () => {
  const fixture = await setup(true)
  const pluginId = 'hot-agent-fixture'
  const directory = path.join(fixture.root, 'hot-plugin')
  await mkdir(path.join(directory, 'dist', 'agent'), { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: pluginId, version: '1.0.0', piMeme: { sdkVersion: 2, agent: 'dist/agent/entry.js' } }),
  )
  await writeFile(
    path.join(directory, 'dist', 'agent', 'entry.js'),
    `export function activate(context) { context.tools.register({ name: 'hot_fixture_tool', title: '热更工具', description: '验证新会话工具集合', parameters: { type: 'object', properties: {} }, execute: async () => ({ text: '工具已执行', data: {} }) }); context.commands.register({ name: 'hot-fixture-command', description: '热更命令', execute: async () => {} }) }\n`,
  )
  const snapshot = async () => {
    const response = await fixture.rpc('a', 'pi:snapshot')
    assert.equal(response.error, undefined)
    return response.result as Snapshot
  }
  const settled = async () => {
    for (let count = 0; count < 200; count++) {
      if (!(await snapshot()).state.isStreaming) return
      await delay(25)
    }
    throw new Error('假模型任务未结束')
  }
  try {
    const key = (await snapshot()).connection.sessionKey!
    await fixture.rpc('a', 'pi:access-mode', [key, 'full-access'], key)
    assert.equal((await fixture.rpc('a', 'pi:prompt', [key, '旧工具集合'], key)).error, undefined)
    assert.equal((await snapshot()).state.isStreaming, true)
    assert.equal((await fixture.rpc('a', 'plugins:install-directory', [directory])).error, undefined)
    const duringInstall = await snapshot()
    assert.equal(duringInstall.state.isStreaming, true)
    assert.equal(
      duringInstall.uiPlugins?.some((plugin) => plugin.id === pluginId),
      false,
    )
    await settled()
    await selectAgentPlugins(fixture.server.host, key, [pluginId])
    assert.equal((await fixture.rpc('a', 'pi:prompt', [key, '新工具集合'], key)).error, undefined)
    assert.ok(
      ((await fixture.rpc('a', 'pi:commands')).result as Array<{ name: string }>).some(
        (command) => command.name === 'hot-fixture-command',
      ),
    )
    assert.equal((await fixture.rpc('a', 'plugins:remove', [pluginId])).error, undefined)
    const duringRemove = await snapshot()
    assert.equal(duringRemove.state.isStreaming, true)
    assert.ok(duringRemove.uiPlugins?.some((plugin) => plugin.id === pluginId))
    await settled()
    assert.equal((await fixture.rpc('a', 'pi:prompt', [key, '卸载后工具集合'], key)).error, undefined)
    await settled()
    assert.equal(
      ((await fixture.rpc('a', 'pi:commands')).result as Array<{ name: string }>).some(
        (command) => command.name === 'hot-fixture-command',
      ),
      false,
    )
    assert.equal(fixture.modelTools[0].includes('hot_fixture_tool'), false)
    assert.equal(fixture.modelTools[1].includes('hot_fixture_tool'), true)
    assert.equal(fixture.modelTools[2].includes('hot_fixture_tool'), false)
  } finally {
    await fixture.dispose()
  }
})

test('客户端短暂断开保留选择，超过宽限期回收空白视图', async () => {
  const fixture = await setup(false, 80)
  try {
    const initial = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
    const unsubscribe = await fixture.server.host.subscribe('a', () => {})
    unsubscribe()
    const reconnect = await fixture.server.host.subscribe('a', () => {})
    assert.equal(
      ((await fixture.rpc('a', 'pi:snapshot')).result as Snapshot).connection.sessionKey,
      initial.connection.sessionKey,
    )
    reconnect()
    await delay(180)
    const returned = (await fixture.rpc('a', 'pi:snapshot')).result as Snapshot
    assert.notEqual(returned.connection.sessionKey, initial.connection.sessionKey)
    assert.equal(returned.state.isStreaming, false)
  } finally {
    await fixture.dispose()
  }
})
