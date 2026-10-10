import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { readSessionHistory } from '@pi-meme/pi-runtime/session-history'
import { createPiRuntimePaths } from '@pi-meme/pi-runtime/runtime-paths'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { ProjectStore } from '../src/server/project-store'
import { SessionService } from '../src/server/session-service'
import { createWorkspaceHandlers } from '../src/server/handlers'
import { deleteSessionFiles, scanProjectSessions } from '../src/server/session-files'

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-sidebar-operations-')))
after(async () => {
  await rm(directory, { recursive: true, force: true })
})
async function setup(name: string) {
  const root = path.join(directory, name)
  const cwd = path.join(root, 'project')
  const runtimePaths = createPiRuntimePaths(path.join(root, 'userData'))
  const sessionsRoot = runtimePaths.sessionsDirectory
  await mkdir(cwd, { recursive: true })
  const projects = new ProjectStore(root)
  await projects.load()
  await projects.register(cwd)
  const pool = new PiSessionPool(
    cwd,
    {
      connection: () => {},
      event: () => {},
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    runtimePaths,
    new MemoryCredentialStorage(),
  )
  pool.configureWorkspaces({
    kind: (value) => projects.kind(value),
    createStandaloneDirectory: () => projects.createStandaloneDirectory(),
  })
  pool.prepare(cwd)
  const sessions = new SessionService(sessionsRoot)
  let pins: string[] = []
  const handlers = createWorkspaceHandlers({
    pi: pool,
    projects,
    sessions,
    mutations: pool,
    getPinnedPaths: () => pins,
    getRuntimeSessions: () => pool.getRuntimeSessions(),
    removePins: async (paths) => {
      pins = pins.filter((item) => !paths.includes(item))
    },
  })
  async function history(id: string, targetCwd = cwd, content = true) {
    const folder = path.join(sessionsRoot, 'mixed-cwds')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, `${id}.jsonl`)
    const timestamp = '2026-10-02T00:00:00Z'
    const header = { type: 'session', version: 3, id, cwd: targetCwd, timestamp }
    const entries = [
      header,
      ...(content
        ? [
            {
              type: 'message',
              id: 'user',
              parentId: null,
              timestamp,
              message: { role: 'user', content: '历史消息', timestamp: 1 },
            },
            {
              type: 'message',
              id: 'assistant',
              parentId: 'user',
              timestamp,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '完成' }],
                timestamp: 2,
                stopReason: 'stop',
                api: 'openai-responses',
                provider: 'test',
                model: 'test',
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              },
            },
          ]
        : []),
    ]
    await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    return file
  }
  return {
    root,
    cwd,
    sessionsRoot,
    projects,
    pool,
    handlers,
    history,
    setPins: (value: string[]) => {
      pins = value
    },
    pins: () => pins,
  }
}

test('项目改名持久化，重新选择保留名称，有历史会话的分组使用显示名称', async () => {
  const context = await setup('rename-project')
  try {
    await context.history('saved')
    await context.handlers['project:rename'](context.cwd, '  新名称  ')
    await context.projects.register(context.cwd)
    assert.equal(
      (await context.handlers['pi:sessions']()).projects.find((item) => item.cwd === context.cwd)?.name,
      '新名称',
    )
    const restored = new ProjectStore(context.root)
    await restored.load()
    assert.equal((await restored.list())[0].name, '新名称')
    await assert.rejects(context.handlers['project:rename'](context.cwd, '  '), /名称不能为空/)
  } finally {
    context.pool.stop()
  }
})

test('历史会话改名使用 SDK，更新内存和缓存，不启动 Pi', async () => {
  const context = await setup('rename-session')
  try {
    const file = await context.history('saved')
    await context.pool.switchSession(file)
    await readSessionHistory(file)
    const original = await readFile(file, 'utf8')
    await context.handlers['session:rename'](file, '  会话新名称  ')
    assert.equal((await readSessionHistory(file)).sessionName, '会话新名称')
    assert.equal((await context.pool.snapshot()).state.sessionName, '会话新名称')
    assert.equal(context.pool.connection().status, 'idle')
    assert.ok((await readFile(file, 'utf8')).startsWith(original))
    assert.equal((await context.handlers['pi:sessions']()).projects[0].sessions[0].name, '会话新名称')
  } finally {
    context.pool.stop()
  }
})

test('项目扫描覆盖全部和空白会话，使用真实 cwd，隔离子项目与其他分叉', async () => {
  const context = await setup('scan')
  try {
    const alias = path.join(context.root, 'alias')
    await symlink(context.cwd, alias)
    const child = path.join(context.cwd, 'child')
    await mkdir(child)
    const targets = await Promise.all(
      Array.from({ length: 35 }, (_, index) =>
        context.history(String(index), index === 0 ? alias : context.cwd, index !== 1),
      ),
    )
    const other = await context.history('other', child)
    await writeFile(path.join(context.sessionsRoot, 'mixed-cwds', 'broken.jsonl'), 'invalid')
    const scan = await scanProjectSessions(context.sessionsRoot, context.cwd)
    assert.equal(scan.paths.length, 35)
    assert.ok(!scan.paths.includes(other))
    assert.equal(scan.warnings.length, 1)
    const result = await deleteSessionFiles(context.sessionsRoot, targets)
    assert.equal(result.deletedPaths.length, 35)
    assert.equal(result.errors.length, 0)
    await readFile(other)
  } finally {
    context.pool.stop()
  }
})

test('删除当前会话进入同项目空白页，清理置顶且缓存不复活，后台删除不切换', async () => {
  const context = await setup('delete-single')
  try {
    const current = await context.history('current')
    const background = await context.history('background')
    await context.pool.switchSession(background)
    await context.pool.switchSession(current)
    const previousKey = context.pool.connection().sessionKey!
    context.setPins([current, background])
    await context.handlers['pi:sessions']()
    const bg = await context.handlers['session:delete'](background)
    assert.equal(bg.selection, undefined)
    assert.equal(context.pool.connection().sessionKey, previousKey)
    const result = await context.handlers['session:delete'](current)
    assert.ok(result.deletedKeys.includes(previousKey))
    assert.equal(result.selection?.cancelled, false)
    assert.equal(context.pool.cwd, context.cwd)
    assert.deepEqual((await context.pool.snapshot()).messages, [])
    assert.deepEqual(context.pins(), [])
    assert.equal((await context.handlers['pi:sessions']()).projects[0].sessions.length, 0)
    await assert.rejects(readSessionHistory(current), { code: 'ENOENT' })
  } finally {
    context.pool.stop()
  }
})

test('项目删除保留目录和代码，清理登记，进入无项目空白页；清单变化拒绝执行', async () => {
  const context = await setup('delete-project')
  try {
    await writeFile(path.join(context.cwd, 'code.ts'), 'const value = 1')
    const first = await context.history('first')
    const preview = await context.handlers['project:delete-preview'](context.cwd)
    const second = await context.history('second', context.cwd, false)
    await assert.rejects(context.handlers['project:remove'](context.cwd, preview.paths), /清单已变化/)
    await readFile(first)
    const next = await context.handlers['project:delete-preview'](context.cwd)
    context.setPins([context.cwd, first])
    const result = await context.handlers['project:remove'](context.cwd, next.paths)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.deletedPaths.sort(), [first, second].sort())
    assert.equal(context.pool.connection().workspaceKind, 'standalone')
    assert.deepEqual(await context.projects.list(), [])
    assert.deepEqual(context.pins(), [])
    assert.equal(await readFile(path.join(context.cwd, 'code.ts'), 'utf8'), 'const value = 1')
    assert.equal((await context.handlers['pi:sessions']()).projects.length, 0)
  } finally {
    context.pool.stop()
  }
})

test('文件删除部分失败保留失败文件，并拒绝会话目录外路径和符号链接', async () => {
  const context = await setup('partial-failure')
  try {
    const saved = await context.history('saved')
    const outside = path.join(context.root, 'outside.jsonl')
    await writeFile(outside, '保留')
    const link = path.join(context.sessionsRoot, 'mixed-cwds', 'link.jsonl')
    await symlink(outside, link)
    const result = await deleteSessionFiles(context.sessionsRoot, [saved, outside, link])
    assert.deepEqual(result.deletedPaths, [saved])
    assert.equal(result.errors.length, 2)
    assert.equal(await readFile(outside, 'utf8'), '保留')
  } finally {
    context.pool.stop()
  }
})

test('项目部分删除失败时保留登记和失败会话，只清理成功删除会话的置顶', async () => {
  const context = await setup('project-partial')
  try {
    const first = await context.history('first')
    const second = await context.history('second')
    context.setPins([context.cwd, first, second])
    const original = context.pool.deleteSessions.bind(context.pool)
    context.pool.deleteSessions = (paths, cwd, _removeFiles, finish) =>
      original(
        paths,
        cwd,
        async () => {
          const result = await deleteSessionFiles(context.sessionsRoot, [first])
          return { ...result, errors: [`无法删除 ${second}：模拟权限错误`] }
        },
        finish,
      )
    const preview = await context.handlers['project:delete-preview'](context.cwd)
    const result = await context.handlers['project:remove'](context.cwd, preview.paths)
    assert.deepEqual(result.deletedPaths, [first])
    assert.equal(result.errors.length, 1)
    assert.equal((await context.projects.list())[0].cwd, context.cwd)
    assert.deepEqual(context.pins(), [context.cwd, second])
    await readFile(second)
    assert.equal((await context.handlers['pi:sessions']()).projects[0].sessions.length, 1)
  } finally {
    context.pool.stop()
  }
})
