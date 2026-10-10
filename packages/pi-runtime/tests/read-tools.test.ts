import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { TaskMode } from '@pi-meme/contracts/plan'
import { SdkSession } from '../src/sdk/session'
import { loadPiSdk } from '../src/sdk/load'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

test('根与独立分支child在默认和Plan三档权限均能真实执行read、ls、grep和find', async (t) => {
  for (const mode of ['default', 'plan'] satisfies TaskMode[])
    for (const access of ['full-access', 'read-only', 'workspace-write'] satisfies AgentAccessMode[])
      await t.test(`${mode}/${access}`, async (t) => {
        if (access !== 'full-access' && process.platform !== 'darwin') return t.skip('受限权限仅支持macOS')
        const directory = await mkdtemp(path.join(tmpdir(), 'pi-read-tools-'))
        const calls = [
          { name: 'ls', arguments: '{"path":"."}' },
          { name: 'grep', arguments: '{"path":".","pattern":"unique-search-token"}' },
          { name: 'find', arguments: '{"path":".","pattern":"example.txt"}' },
          { name: 'read', arguments: '{"path":"example.txt"}' },
        ]
        const fake = await useFakeAgent(directory, {
          reply: (_body, index) => {
            const tool = calls[(index - 1) % 5]
            return tool ? { tool } : '只读任务完成'
          },
        })
        const sessions: SdkSession[] = []
        let source: string | undefined
        let parentTools: string[] | undefined
        try {
          await writeFile(path.join(directory, 'example.txt'), 'unique-search-token\n')
          for (const role of ['root', 'child']) {
            const session = new SdkSession(
              directory,
              { connection: () => {}, error: () => {}, event: () => {} },
              fake.runtimePaths,
              fake.credentials,
            )
            sessions.push(session)
            session.configureAccess(access)
            await session.setSessionMode(mode)
            let sessionFile: string | undefined
            if (source) {
              const sdk = await loadPiSdk()
              const manager = sdk.SessionManager.open(source, path.dirname(source), directory)
              sessionFile = manager.createBranchedSession(manager.getLeafId()!)
              await session.configureAgentTask('只读取文件和搜索')
            }
            session.start(directory, sessionFile)
            await session.snapshot()
            await session.setModel({ provider: 'fake', id: 'first' })
            const requestIndex = fake.provider.requests.length
            await session.prompt(`${role}只读工具验收`)
            const deadline = Date.now() + 10_000
            while ((await session.snapshot()).state.isStreaming) {
              if (Date.now() > deadline) throw new Error('只读工具测试未结束')
              await delay(10)
            }
            const names = fake.provider.requests[requestIndex].tools
              .map((tool: { function: { name: string } }) => tool.function.name)
              .sort()
            if (parentTools) assert.deepEqual(names, parentTools)
            else parentTools = names
            for (const name of ['read', 'ls', 'grep', 'find']) assert.ok(names.includes(name), `${role}缺少${name}`)
            if (mode === 'plan')
              for (const name of ['bash', 'write', 'edit', 'codemode', 'mcp__read', 'external'])
                assert.ok(!names.includes(name))
            const messages = (await session.snapshot()).messages
            const results = messages.filter((message) => message.role === 'toolResult').slice(-4)
            assert.equal(results.length, 4)
            for (const [index, result] of results.entries()) {
              assert.ok(result.role === 'toolResult')
              assert.equal(result.toolName, calls[index]!.name)
              assert.equal(result.isError, false, JSON.stringify(result.content))
              assert.match(JSON.stringify(result.content), index === 3 ? /unique-search-token/ : /example.txt/)
            }
            source = session.getActiveSession().sessionFile
            assert.ok(source)
            assert.match(await readFile(source, 'utf8'), /unique-search-token/)
            await session.stopAndWait()
          }
        } finally {
          await Promise.all(sessions.map((session) => session.stopAndWait()))
          await fake.dispose()
          await rm(directory, { recursive: true, force: true })
        }
      })
})
