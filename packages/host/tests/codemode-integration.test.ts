import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Snapshot } from '@pi-meme/contracts/desktop'
import type { SettingsSnapshot } from '@pi-meme/contracts/settings'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createHost } from '../src/service'

async function eventually(check: () => Promise<boolean>) {
  for (let count = 0; count < 400; count++) {
    if (await check()) return
    await delay(25)
  }
  throw new Error('等待内置工具任务结束超时')
}

for (const legacy of [false, undefined]) {
  test(
    `codemode旧字段${legacy === false ? '为false' : '缺失'}和保存false均保留内置工具，MCP旧false仍拒绝未授权服务`,
    { timeout: 30000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'host-codemode-'))
      let readPath = ''
      const fake = await useFakeAgent(root, {
        reply: (body) => {
          const last = body.messages?.at(-1)
          if (last?.role === 'tool') return { text: '内置工具完成' }
          return {
            tool: {
              name: 'codemode',
              arguments: JSON.stringify({ code: `text(await tools.read({ path: ${JSON.stringify(readPath)} }));` }),
            },
          }
        },
      })
      const dataRoot = path.join(root, 'userData')
      await writeFile(
        path.join(dataRoot, 'settings.json'),
        JSON.stringify({ themeId: 'dark', codemodeEnabled: legacy, mcpEnabled: false }),
      )
      const mcpLog = path.join(root, 'mcp.log')
      await writeFile(
        path.join(fake.agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            legacy: {
              command: process.execPath,
              args: [fileURLToPath(new URL('../../../tests/fixtures/mcp-server.mjs', import.meta.url)), '--stdio'],
              exposure: 'direct',
              env: { MCP_FIXTURE_LOG: mcpLog },
            },
          },
        }),
      )
      const host = await createHost({ dataRoot, credentials: fake.credentials })
      const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
        host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
      try {
        const initial = (await rpc('pi:snapshot')).result as Snapshot
        const key = initial.connection.sessionKey!
        readPath = path.join(initial.connection.cwd, 'read-fixture.txt')
        await writeFile(readPath, '内置读取正常')
        assert.equal(initial.agent?.accessMode, 'workspace-write')
        for (const phase of ['旧配置启动', '保存旧false后']) {
          assert.equal((await rpc('pi:prompt', [key, phase], key)).error, undefined)
          await eventually(async () => ((await rpc('pi:snapshot')).result as Snapshot).agent?.status === 'completed')
          const snapshot = (await rpc('pi:snapshot')).result as Snapshot
          assert.equal(snapshot.agent?.accessMode, 'workspace-write')
          const result = snapshot.messages.filter((message) => message.role === 'toolResult').at(-1)
          assert.ok(result?.role === 'toolResult' && result.toolName === 'codemode')
          assert.ok(!result.isError)
          assert.match(JSON.stringify(result.content), /内置读取正常/)
          if (phase === '保存旧false后') continue
          const settings = (await rpc('settings:get')).result as SettingsSnapshot
          assert.equal(
            (await rpc('settings:save', [{ ...settings.settings, codemodeEnabled: true, mcpEnabled: false }])).error,
            undefined,
          )
          assert.equal(
            (await rpc('settings:save', [{ ...settings.settings, codemodeEnabled: false, mcpEnabled: false }])).error,
            undefined,
          )
        }
        for (const request of fake.provider.requests) {
          const tools = request.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? []
          assert.equal(tools.filter((name: string) => name === 'codemode').length, 1)
          assert.ok(tools.every((name: string) => !name.startsWith('mcp__')))
        }
        await assert.rejects(readFile(mcpLog), /ENOENT/)
      } finally {
        await host.dispose()
        await fake.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
}

test('规划根任务与后代拒绝伪造codemode调用，保持继承权限且不写文件', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-plan-codemode-'))
  const marker = path.join(root, '禁止写入.txt')
  let spawned = false
  let rootAttempted = false
  let childAttempted = false
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      const text = JSON.stringify((body.messages ?? []).filter((message: { role: string }) => message.role === 'user'))
      const child = text.includes('子任务检查规划工具')
      if (!child && !spawned) {
        spawned = true
        return {
          tool: {
            name: 'spawn_agent',
            arguments: JSON.stringify({ task_name: 'reader', message: '子任务检查规划工具', fork_turns: 'none' }),
          },
        }
      }
      if ((child && !childAttempted) || (!child && !rootAttempted)) {
        if (child) childAttempted = true
        else rootAttempted = true
        return {
          tool: {
            name: 'codemode',
            arguments: JSON.stringify({ code: `await tools.write({path:${JSON.stringify(marker)},content:'禁止'});` }),
          },
        }
      }
      return { text: '只读检查完成' }
    },
  })
  const host = await createHost({ dataRoot: path.join(root, 'userData'), credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args, sessionId })
  try {
    const key = ((await rpc('pi:snapshot')).result as Snapshot).connection.sessionKey!
    assert.equal((await rpc('pi:prompt', [key, '检查根任务规划工具', [], [], { mode: 'plan' }], key)).error, undefined)
    await eventually(async () => {
      const snapshot = (await rpc('pi:snapshot')).result as Snapshot
      return (
        snapshot.agent?.status === 'completed' &&
        Boolean(snapshot.agents?.some((agent) => agent.depth === 1 && agent.status === 'completed'))
      )
    })
    const snapshot = (await rpc('pi:snapshot')).result as Snapshot
    assert.equal(rootAttempted, true)
    assert.equal(childAttempted, true)
    assert.ok(snapshot.agents?.every((agent) => agent.mode === 'plan' && agent.accessMode === 'workspace-write'))
    for (const request of fake.provider.requests) {
      const tools = request.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? []
      assert.ok(!tools.includes('codemode') && !tools.includes('write') && !tools.includes('bash'))
    }
    const rootResult = snapshot.messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'codemode',
    )
    assert.ok(rootResult?.role === 'toolResult' && rootResult.isError)
    const child = snapshot.agents!.find((agent) => agent.depth === 1)!
    const childSnapshot = (await rpc('pi:agent-snapshot', [child.agentId])).result as Snapshot
    assert.ok(
      childSnapshot.messages.some(
        (message) => message.role === 'toolResult' && message.toolName === 'codemode' && message.isError,
      ),
    )
    await assert.rejects(readFile(marker), /ENOENT/)
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
