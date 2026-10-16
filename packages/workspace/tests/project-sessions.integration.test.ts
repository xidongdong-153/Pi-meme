import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectStore } from '../src/server/project-store'
import { SessionService } from '../src/server/session-service'
import { createWorkspaceHandlers } from '../src/server/handlers'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'

test('项目列表使用真实会话头，无会话项目保留，无项目历史单独分组', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-project-sessions-'))
  const store = new ProjectStore(directory)
  const pool = new PiSessionPool(directory, {
    connection: () => {},
    event: () => {},
    error: () => {},
    sessionsChanged: () => {},
  })
  try {
    await store.load()
    const standalone = await store.createStandaloneDirectory()
    const project = path.join(directory, '项目-带连字符')
    const empty = path.join(directory, 'empty')
    await mkdir(project)
    await mkdir(empty)
    await store.register(empty)
    const sessionsRoot = path.join(directory, 'history')
    async function history(name: string, cwd: string) {
      const folder = path.join(sessionsRoot, name)
      await mkdir(folder, { recursive: true })
      const timestamp = '2026-09-29T00:00:00Z'
      await writeFile(
        path.join(folder, 'saved.jsonl'),
        [
          { type: 'session', id: name, version: 3, cwd, timestamp },
          {
            type: 'message',
            id: 'user',
            parentId: null,
            timestamp,
            message: { role: 'user', content: '已保存会话', timestamp: 1 },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n'),
      )
    }
    await history('--完全不同的编码目录--', project)
    await history('--standalone--', standalone)
    pool.configureWorkspaces({
      kind: (cwd) => store.kind(cwd),
      createStandaloneDirectory: () => store.createStandaloneDirectory(),
    })
    pool.prepare(standalone)
    const handlers = createWorkspaceHandlers({
      pi: pool,
      projects: store,
      sessions: new SessionService(sessionsRoot),
      getPinnedPaths: () => [],
    })
    const projects = await handlers['workspace:projects']()
    assert.equal(projects.length, 2)
    assert.ok(projects.some((item) => item.name === '项目-带连字符'))
    assert.ok(!projects.some((item) => item.cwd.includes('standalone-workspaces')))
    const snapshot = await handlers['pi:sessions']()
    assert.equal(snapshot.projects.length, 2)
    assert.equal(snapshot.projects.find((item) => item.name === 'empty')?.sessionCount, 0)
    assert.equal(snapshot.standaloneSessions?.length, 1)
    assert.equal(snapshot.standaloneSessions?.[0].cwd, standalone)
    assert.equal(snapshot.standaloneSessions?.[0].workspaceKind, 'standalone')
    assert.equal(snapshot.recents.find((item) => item.cwd === standalone)?.workspaceKind, 'standalone')
  } finally {
    pool.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
