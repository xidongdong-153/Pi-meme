import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import { AccessSandbox } from '@pi-meme/pi-runtime/sdk/access-sandbox'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createHost } from '../src/service'

for (const reason of [
  'ENOENT: /usr/bin/bwrap',
  'bwrap: namespace: Operation not permitted',
  'bwrap: seccomp: Invalid argument',
]) {
  test(`沙箱探测失败仍可读取设置，默认会话拒绝执行并保留权限：${reason}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'host-sandbox-unavailable-'))
    const fake = await useFakeAgent(root)
    t.mock.method(AccessSandbox, 'create', async () => {
      throw new Error(reason)
    })
    const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
    const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
      host.rpc({
        requestId: crypto.randomUUID(),
        clientId: 'unavailable',
        method,
        args,
        sessionId,
      })
    try {
      assert.equal((await rpc('settings:get')).error, undefined)
      const snapshot = (await rpc('pi:snapshot')).result as Snapshot
      assert.equal(snapshot.connection.accessMode, 'workspace-write')
      assert.equal(snapshot.connection.restrictedAccessSupported, false)
      assert.ok(snapshot.connection.restrictedAccessReason?.includes(reason))
      const key = snapshot.connection.sessionKey!
      assert.ok((await rpc('pi:prompt', [key, '不允许执行'], key)).error?.message.includes(reason))
      assert.ok((await rpc('pi:access-mode', [key, 'read-only'], key)).error?.message.includes(reason))
      const after = (await rpc('pi:snapshot')).result as Snapshot
      assert.equal(after.connection.accessMode, 'workspace-write')
      assert.equal(after.agent?.accessMode, 'workspace-write')
      assert.equal(fake.provider.requests.length, 0)
    } finally {
      await host.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('默认工作区会话的子代理沿用同一沙箱，bash 和 codemode 都不能越界写入', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-child-sandbox-'))
  const outside = path.join(root, 'outside.txt')
  await writeFile(outside, 'original')
  let spawned = false
  let childStep = 0
  let inside = ''
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      const users = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'user'))
      if (users.includes('CHILD_BOUNDARY：')) {
        childStep++
        if (childStep === 1)
          return {
            tool: {
              name: 'bash',
              arguments: JSON.stringify({ command: `echo forbidden > ${JSON.stringify(outside)}` }),
            },
          }
        if (childStep === 2)
          return {
            tool: {
              name: 'codemode',
              arguments: JSON.stringify({
                code: `text((await Promise.allSettled([tools.write({path:${JSON.stringify(inside)},content:'inside'}),tools.write({path:${JSON.stringify(outside)},content:'forbidden'})])).map(result=>result.status));`,
              }),
            },
          }
        return '子任务完成'
      }
      if (!spawned) {
        spawned = true
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({
              task_name: 'writer',
              message: 'CHILD_BOUNDARY：验证文件写入边界',
              fork_turns: 'none',
            }),
          },
        }
      }
      return '主任务完成'
    },
  })
  const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  const rpc = async <T>(method: string, args: unknown[] = [], sessionId?: string): Promise<T> => {
    const response = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'child-boundary',
      method,
      args,
      sessionId,
    })
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    return response.result as T
  }
  try {
    let snapshot = await rpc<Snapshot>('pi:snapshot')
    const key = snapshot.connection.sessionKey!
    inside = path.join(snapshot.connection.cwd, 'child.txt')
    await rpc('pi:prompt', [key, 'PARENT_BOUNDARY：验证子任务'], key)
    for (let count = 0; count < 400; count++) {
      snapshot = await rpc<Snapshot>('pi:snapshot', [], key)
      if (snapshot.agents?.some((agent) => agent.depth === 1 && agent.status === 'completed')) break
      await delay(25)
    }
    const child = snapshot.agents?.find((agent) => agent.depth === 1)
    assert.ok(child && child.status === 'completed', JSON.stringify(snapshot.agents))
    assert.equal(child.accessMode, 'workspace-write')
    const childSnapshot = await rpc<Snapshot>('pi:agent-snapshot', [child.agentId])
    assert.ok(
      childSnapshot.messages.some(
        (message) => message.role === 'toolResult' && message.toolName === 'bash' && message.isError,
      ),
    )
    assert.ok(
      childSnapshot.messages.some(
        (message) =>
          message.role === 'toolResult' &&
          message.toolName === 'codemode' &&
          JSON.stringify(message).includes('rejected'),
      ),
    )
    assert.equal(await readFile(inside, 'utf8'), 'inside')
    assert.equal(await readFile(outside, 'utf8'), 'original')
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
