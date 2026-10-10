import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpConfigStore } from '../src/server/config-store'
import { createMcpHandlers } from '../src/server/handlers'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

test('配置读取不启动会话；保存重连保留模型和消息；运行时阻止保存；重连失败保留落盘配置', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-mcp-handlers-'))
  const project = path.join(directory, 'project')
  await mkdir(project)
  const agent = await useFakeAgent(directory, {
    models: [
      { id: 'first', name: '模型 first', reasoning: true },
      { id: 'second', name: '模型 second', reasoning: true },
    ],
    reply: (body) => ({ text: '收到', delayMs: requestText(body).includes('slow') ? 1000 : 0 }),
  })
  const pi = new PiSessionPool(
    project,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  const store = new McpConfigStore(path.join(agent.runtimePaths.agentDir, 'mcp.json'), agent.credentials)
  const handlers = createMcpHandlers({ pi, store })
  try {
    pi.prepare(project)
    const snapshot = await handlers['mcp:get']()
    assert.equal(pi.connection().status, 'idle')
    const key = pi.connection().sessionKey!
    await assert.rejects(handlers['mcp:check'](key), /完全权限/)
    await assert.rejects(handlers['mcp:check']('stale-session'), /完全权限/)
    await pi.setModel(key, { provider: 'fake', id: 'second' })
    await pi.prompt(key, '配置前的消息 slow')
    await assert.rejects(
      handlers['mcp:save']({ revision: snapshot.revision, name: 'docs', config: { url: 'https://example.com/mcp' } }),
      /会话正在运行/,
    )
    await pi.abort(key)
    const updated = await handlers['mcp:save']({
      revision: snapshot.revision,
      name: 'docs',
      config: { url: 'https://example.com/mcp' },
    })
    assert.equal((await pi.snapshot()).state.model?.id, 'second')
    assert.ok((await pi.snapshot()).messages.some((message) => message.role === 'user'))
    // 重连失败时，已保存的 MCP 配置仍保留在磁盘中
    const reconnectModels = pi.reconnectModels
    pi.reconnectModels = async () => {
      throw new Error('模拟重连失败')
    }
    try {
      await assert.rejects(
        handlers['mcp:save']({
          revision: updated.revision,
          name: 'docs',
          previousName: 'docs',
          config: { url: 'https://example.com/mcp', enabled: false },
        }),
        /配置已保存.*重连失败/,
      )
    } finally {
      pi.reconnectModels = reconnectModels
    }
    assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).mcpServers.docs.enabled, false)
  } finally {
    pi.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
