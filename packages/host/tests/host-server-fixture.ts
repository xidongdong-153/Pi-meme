import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, rm, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startHostServer } from '../src/server'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import type { HostRpcResponse } from '@pi-meme/contracts/host'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
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

export { installAgentFixture, selectAgentPlugins, setup }
