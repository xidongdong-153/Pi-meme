import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { reservedPluginIds } from '@pi-meme/plugin-sdk/reserved'
import { initEmptyStorageLayout } from '../src/storage/upgrade'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import { sandboxPluginId } from '../src/sandbox-platform'
import { createHost } from '../src/service'

test('没有外部插件或恢复清单损坏时，内置模块与基础操作仍可用', async () => {
  for (const legacy of [false, true, '损坏'] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'host-static-modules-'))
    let host: Awaited<ReturnType<typeof createHost>> | undefined
    try {
      await initEmptyStorageLayout(root)
      const state = path.join(root, storageLayoutRelativePaths.pluginsFile)
      await mkdir(path.dirname(state), { recursive: true })
      const contents =
        legacy === '损坏'
          ? '{bad'
          : JSON.stringify(
              legacy
                ? reservedPluginIds.map((id) => ({ id, directory: '/不存在', builtin: true, enabled: false }))
                : [],
            )
      await writeFile(state, contents)
      host = await createHost({ dataRoot: root, credentials: new MemoryCredentialStorage() })
      const rpc = (method: string, args: unknown[] = []) =>
        host!.rpc({ requestId: crypto.randomUUID(), clientId: 'client', method, args })
      assert.deepEqual(
        ((await rpc('plugins:list')).result as Array<{ builtin?: boolean }>).filter((plugin) => !plugin.builtin),
        [],
      )
      const modules = (await rpc('host:modules')).result as Array<{ id: string }>
      assert.deepEqual(
        new Set(modules.map((module) => module.id)),
        new Set(
          reservedPluginIds.filter(
            (id) =>
              !['@pi-meme/file-directory', '@pi-meme/terminal', '@pi-meme/activities'].includes(id) &&
              (!id.startsWith('@pi-meme/sandbox-') || id === sandboxPluginId()),
          ),
        ),
      )
      for (const method of ['settings:get', 'models:get', 'mcp:get', 'resources:catalog'])
        assert.equal((await rpc(method, [])).error, undefined)
      for (const id of reservedPluginIds)
        for (const method of ['plugins:enable', 'plugins:disable', 'plugins:remove', 'plugins:reload'])
          assert.match((await rpc(method, [id])).error?.message ?? '', /内置模块/)
      const diagnostics = (await rpc('plugins:diagnostics')).result as unknown[]
      assert.equal(diagnostics.length, legacy === '损坏' ? 1 : 0)
      if (legacy === '损坏') assert.equal(await readFile(state, 'utf8'), contents)
    } finally {
      await host?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('持久子历史超过 recent 上限时仍不占 recent、项目计数或置顶位置', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'host-child-history-')))
  let host: Awaited<ReturnType<typeof createHost>> | undefined
  try {
    await initEmptyStorageLayout(root)
    const cwd = path.join(root, 'project')
    const directory = path.join(root, storageLayoutRelativePaths.sessionsDataDirectory, 'fixture')
    await mkdir(cwd)
    await mkdir(directory, { recursive: true })
    const records = []
    const children: string[] = []
    for (let index = 0; index < 42; index++) {
      const id = `session-${index}`
      const file = path.join(directory, `${id}.jsonl`)
      const stamp = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()
      await writeFile(
        file,
        [
          { type: 'session', id, cwd, version: 3, timestamp: stamp },
          {
            type: 'message',
            id: `user-${index}`,
            parentId: null,
            timestamp: stamp,
            message: { role: 'user', content: [{ type: 'text', text: `会话 ${index}` }], timestamp: Date.parse(stamp) },
          },
          {
            type: 'message',
            id: `assistant-${index}`,
            parentId: `user-${index}`,
            timestamp: stamp,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '完成' }],
              timestamp: Date.parse(stamp),
              stopReason: 'stop',
              api: 'openai-completions',
              provider: 'fake',
              model: 'fake',
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n'),
      )
      if (index < 2) continue
      children.push(file)
      records.push({
        summary: {
          agentId: `child-${index}`,
          rootAgentId: 'past-root',
          parentAgentId: 'past-root',
          name: `child-${index}`,
          taskPath: `/root/child-${index}`,
          depth: 1,
          rootSessionKey: 'past-root',
          sessionKey: `agent:child-${index}`,
          sessionId: id,
          sessionFile: file,
          rootTaskId: 'past-task',
          epoch: 1,
          executionGeneration: 1,
          status: 'completed',
          cwd,
          accessMode: 'full-access',
          mode: 'default',
          updatedAt: stamp,
        },
        mailbox: [],
        consumed: [],
        queued: [],
        interactions: [],
        sequence: 0,
      })
    }
    const rootsDir = path.join(root, storageLayoutRelativePaths.collaborationRootsDirectory)
    await mkdir(rootsDir, { recursive: true })
    await writeFile(
      path.join(rootsDir, 'past-root.json'),
      JSON.stringify({ version: 1, rootAgentId: 'past-root', records }),
    )
    host = await createHost({ dataRoot: root, credentials: new MemoryCredentialStorage() })
    await host.settings.save({
      ...host.settings.settings,
      pinnedPaths: [children[0]!, path.join(directory, 'session-0.jsonl')],
    })
    const response = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'history',
      method: 'pi:sessions',
      args: [],
    })
    assert.equal(response.error, undefined)
    const value = response.result as import('@pi-meme/contracts/sessions').PiSessionsSnapshot
    assert.equal(value.recents.length, 2)
    assert.ok(value.recents.every((session) => !children.includes(session.path)))
    assert.equal(value.projects.find((group) => group.cwd === cwd)?.sessionCount, 2)
    assert.deepEqual(value.pinnedPaths, [path.join(directory, 'session-0.jsonl')])
  } finally {
    await host?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
