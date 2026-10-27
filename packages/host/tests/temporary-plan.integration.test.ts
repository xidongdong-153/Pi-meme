import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import type { DesktopEvent, Snapshot } from '@pi-meme/contracts/desktop'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import { createHost } from '../src/service'
import { finishAgentReply, useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

async function filesContaining(directory: string, text: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await filesContaining(file, text)))
    else if (entry.isFile() && (await readFile(file)).includes(Buffer.from(text))) result.push(file)
  }
  return result
}

test('临时聊天生成的原生计划不会写入持久计划或控制日志，关闭后清除文件', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-temporary-plan-'))
  const marker = '临时聊天计划内容-隔离验证'
  const inputMarker = '临时聊天输入内容-隔离验证'
  let saved = false
  const fake = await useFakeAgent(root, {
    reply: () => {
      if (saved) return { text: '方案已保存' }
      saved = true
      return { tool: { name: 'save_plan', arguments: JSON.stringify({ title: '临时方案', markdown: `# ${marker}` }) } }
    },
  })
  const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  const rpc = async <T>(method: string, args: unknown[] = [], sessionId?: string): Promise<T> => {
    const result = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'temporary-plan-owner',
      method,
      args,
      sessionId,
    })
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    return result.result as T
  }
  try {
    const source = await rpc<Snapshot>('pi:snapshot')
    const sourceKey = source.connection.sessionKey!
    const opened = await rpc<Snapshot>('temporary-session:open', [{ sourceSessionKey: sourceKey }], sourceKey)
    const sideKey = opened.connection.sessionKey!
    const session = opened.appSession!
    const otherWindow = await host.control.dispatch({
      apiVersion: 2,
      hostId: host.hostId,
      clientId: 'other-window',
      method: 'sessions.get',
      args: [{ hostId: session.hostId, sessionId: session.sessionId }],
    })
    assert.ok(otherWindow.error, '其他窗口不能读取临时会话')
    await rpc('pi:prompt', [sideKey, inputMarker, [], [], { mode: 'plan' }], sideKey)
    let side: Snapshot | undefined
    for (let count = 0; count < 200; count++) {
      side = await rpc<Snapshot>('pi:snapshot', [], sideKey)
      if (!side.state.isStreaming && side.planDocuments?.length) break
      await delay(25)
    }
    assert.equal(side?.planDocuments?.[0]?.markdown, `# ${marker}`)
    assert.ok(side?.appSession?.sessionFile, '首次发送后 appSession 必须包含实际 sessionFile')
    assert.ok(
      side?.appSession?.sessionFile?.includes(`${path.sep}temporary-sessions${path.sep}`),
      'appSession.sessionFile 必须位于临时会话目录',
    )
    assert.equal(side?.appSession?.temporary, true)
    const dataRoot = fake.runtimePaths.dataRoot
    for (const content of [marker, inputMarker]) {
      const matches = await filesContaining(dataRoot, content)
      assert.ok(matches.length > 0, '计划和输入应保存在临时会话文件中')
      assert.ok(
        matches.every((file) => file.includes(`${path.sep}temporary-sessions${path.sep}`)),
        matches.join('\n'),
      )
    }
    await rpc('temporary-session:close', [sideKey], sideKey)
    assert.deepEqual(await filesContaining(dataRoot, marker), [])
    assert.deepEqual(await filesContaining(dataRoot, inputMarker), [])
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('临时子代理的会话文件和事件只属于创建窗口，关闭后删除', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-temporary-agent-'))
  const marker = '临时子代理内容-隔离验证'
  let spawned = false
  const fake = await useFakeAgent(root, {
    reply: (body: { messages?: Array<{ role: string; content: unknown }> }) => {
      const userText = (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => JSON.stringify(message.content))
        .join('\n')
      if (userText.includes(marker)) return finishAgentReply(body, marker)
      if (!spawned) {
        spawned = true
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({ task_name: 'worker', message: marker, fork_turns: 'none' }),
          },
        }
      }
      return { text: '根任务完成' }
    },
  })
  const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  const rpc = (clientId: string, method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId, method, args, sessionId })
  const ownerEvents: DesktopEvent[] = []
  const otherEvents: DesktopEvent[] = []
  const unsubscribeOwner = await host.subscribe('side-owner', (event) => {
    if (event.type === 'event') ownerEvents.push(event.value)
  })
  const unsubscribeOther = await host.subscribe('other-window', (event) => {
    if (event.type === 'event') otherEvents.push(event.value)
  })
  try {
    const source = (await rpc('side-owner', 'pi:snapshot')).result as Snapshot
    const sourceKey = source.connection.sessionKey!
    const opened = await rpc('side-owner', 'temporary-session:open', [{ sourceSessionKey: sourceKey }], sourceKey)
    assert.equal(opened.error, undefined)
    const sideKey = (opened.result as Snapshot).connection.sessionKey!
    assert.equal((await rpc('side-owner', 'pi:prompt', [sideKey, '请派一个子任务', [], []], sideKey)).error, undefined)
    let child: AgentSummary | undefined
    for (let count = 0; count < 400; count++) {
      const response = await rpc('side-owner', 'pi:agents', [sideKey], sideKey)
      assert.equal(response.error, undefined)
      child = (response.result as AgentSummary[]).find((agent) => agent.depth === 1)
      if (child?.status === 'completed' && child.sessionFile) break
      await delay(25)
    }
    assert.equal(child?.status, 'completed')
    assert.ok(child.sessionFile?.includes(`${path.sep}temporary-sessions${path.sep}`))
    const matches = await filesContaining(fake.runtimePaths.dataRoot, marker)
    assert.ok(matches.length > 0, '子代理内容应写入临时文件')
    assert.ok(
      matches.every((file) => file.includes(`${path.sep}temporary-sessions${path.sep}`)),
      matches.join('\n'),
    )
    const ownerSnapshot = await rpc('side-owner', 'pi:agent-snapshot', [child.agentId])
    assert.equal(ownerSnapshot.error, undefined)
    const otherSnapshot = await rpc('other-window', 'pi:agent-snapshot', [child.agentId])
    assert.ok(otherSnapshot.error, '其他窗口不能读取子代理快照')
    const otherInterrupt = await rpc('other-window', 'pi:interrupt-agent', [child.agentId])
    assert.ok(otherInterrupt.error, '其他窗口不能中断子代理')
    assert.ok(ownerEvents.some((event) => event.agentId === child!.agentId))
    assert.ok(!otherEvents.some((event) => event.agentId === child!.agentId))

    // 验证 HostApi v2 agents.get / agents.stop 跨窗口鉴权与操作日志隔离
    const otherAgentGet = await host.control.dispatch({
      apiVersion: 2,
      hostId: host.hostId,
      clientId: 'other-window',
      method: 'agents.get',
      args: [child.agentId],
    })
    assert.ok(otherAgentGet.error, 'HostApi agents.get 拒绝非所有者窗口访问临时子代理')

    const otherAgentStop = await host.control.dispatch({
      apiVersion: 2,
      hostId: host.hostId,
      clientId: 'other-window',
      method: 'agents.stop',
      args: [child.agentId, { idempotencyKey: 'other-stop-child' }],
    })
    assert.ok(otherAgentStop.error, 'HostApi agents.stop 拒绝非所有者窗口中断临时子代理')

    const ownerAgentGet = await host.control.dispatch({
      apiVersion: 2,
      hostId: host.hostId,
      clientId: 'side-owner',
      method: 'agents.get',
      args: [child.agentId],
    })
    assert.equal(ownerAgentGet.error, undefined, 'HostApi agents.get 允许 owner 访问')

    const ownerAgentStop = await host.control.dispatch({
      apiVersion: 2,
      hostId: host.hostId,
      clientId: 'side-owner',
      method: 'agents.stop',
      args: [child.agentId, { idempotencyKey: 'owner-stop-child' }],
    })
    assert.equal(ownerAgentStop.error, undefined, 'HostApi agents.stop 允许 owner 中断')

    const opsFile = path.join(fake.runtimePaths.dataRoot, 'state/control/operations.jsonl')
    const opsContent = await readFile(opsFile, 'utf8').catch(() => '')
    assert.ok(!opsContent.includes(child.agentId), '临时子代理控制操作不写入持久 operations.jsonl')

    assert.equal((await rpc('side-owner', 'temporary-session:close', [sideKey], sideKey)).error, undefined)
    assert.deepEqual(await filesContaining(fake.runtimePaths.dataRoot, marker), [])
  } finally {
    unsubscribeOwner()
    unsubscribeOther()
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
