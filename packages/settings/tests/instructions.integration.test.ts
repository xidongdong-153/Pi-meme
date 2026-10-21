import assert from 'node:assert/strict'
import { test } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { InstructionsStore, parseSaveInstruction } from '../src/server/instructions'
import { createSettingsHandlers } from '../src/server/handlers'
import { SettingsStore } from '../src/server/store'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-instructions-'))
  const agentDir = path.join(root, 'config', 'agent')
  const project = path.join(root, 'project')
  await mkdir(agentDir, { recursive: true })
  await mkdir(path.join(project, '.pi'), { recursive: true })
  return { root, agentDir, project, store: new InstructionsStore(root) }
}

test('指令快照与原生 AGENTS override、项目系统指令覆盖一致，不扫描祖先目录', async () => {
  const { root, agentDir, project, store } = await fixture()
  try {
    await writeFile(path.join(root, 'AGENTS.md'), '不加载的祖先指令')
    await writeFile(path.join(agentDir, 'AGENTS.md'), 'Host 常规指令')
    await writeFile(path.join(agentDir, 'AGENTS.override.md'), 'Host 覆盖指令')
    await writeFile(path.join(agentDir, 'SYSTEM.md'), 'Host 系统指令')
    await writeFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'Host 追加指令')
    await writeFile(path.join(project, 'AGENTS.override.md'), '项目覆盖指令')
    await writeFile(path.join(project, '.pi', 'SYSTEM.md'), '项目系统指令')
    await writeFile(path.join(project, '.pi', 'APPEND_SYSTEM.md'), '项目追加指令')
    const snapshot = await store.snapshot(project)
    const [agents, append, system] = snapshot.entries
    assert.equal(agents.host.path, await realpath(path.join(agentDir, 'AGENTS.override.md')))
    assert.equal(agents.host.content, 'Host 覆盖指令')
    assert.equal(agents.project?.content, '项目覆盖指令')
    assert.equal(agents.effective, 'combined')
    assert.equal(system.effective, 'project')
    assert.equal(append.effective, 'project')
    await store.save({ kind: 'agents', content: '修改 Host 覆盖指令', revision: agents.host.revision })
    assert.equal(await readFile(path.join(agentDir, 'AGENTS.md'), 'utf8'), 'Host 常规指令')
    assert.equal(await readFile(path.join(project, 'AGENTS.override.md'), 'utf8'), '项目覆盖指令')
    await rm(path.join(project, 'AGENTS.override.md'))
    assert.equal((await store.snapshot(project)).entries[0].project, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('空文本保留空文件；移除 override 后回落，删除系统指令恢复默认来源', async () => {
  const { root, agentDir, project, store } = await fixture()
  try {
    const initial = await store.snapshot(project)
    assert.ok(initial.entries.every((entry) => entry.effective === 'default'))
    await store.save({ kind: 'system', content: '', revision: initial.entries[2].host.revision })
    const saved = (await store.snapshot(project)).entries[2].host
    assert.equal(saved.exists, true)
    assert.equal(await readFile(saved.path, 'utf8'), '')
    await store.save({ kind: 'system', content: null, revision: saved.revision })
    assert.equal((await store.snapshot(project)).entries[2].effective, 'default')
    await writeFile(path.join(agentDir, 'AGENTS.md'), '基础指令')
    await writeFile(path.join(agentDir, 'AGENTS.override.md'), '覆盖指令')
    const agents = (await store.snapshot(project)).entries[0].host
    await store.save({ kind: 'agents', content: null, revision: agents.revision })
    assert.equal((await store.snapshot(project)).entries[0].host.content, '基础指令')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('文件变更与 override 切换拒绝过期保存，参数不接受路径', async () => {
  const { root, agentDir, project, store } = await fixture()
  try {
    const original = (await store.snapshot(project)).entries[0].host
    await writeFile(path.join(agentDir, 'AGENTS.md'), '外部修改')
    await assert.rejects(store.save({ kind: 'agents', content: '旧草稿', revision: original.revision }), /重新读取/)
    const current = (await store.snapshot(project)).entries[0].host
    await writeFile(path.join(agentDir, 'AGENTS.override.md'), '新覆盖文件')
    await assert.rejects(store.save({ kind: 'agents', content: null, revision: current.revision }), /重新读取/)
    assert.equal(await readFile(path.join(agentDir, 'AGENTS.md'), 'utf8'), '外部修改')
    for (const value of [
      null,
      { kind: '../SYSTEM', content: '越界', revision: current.revision },
      { kind: 'agents', content: {}, revision: current.revision },
      { kind: 'agents', content: '越界', revision: current.revision, path: '/tmp/other' },
    ])
      assert.throws(() => parseSaveInstruction(value))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('拒绝通过文件或目录软链接访问 Host 指令目录之外，项目文件只读', async () => {
  const { root, agentDir, project, store } = await fixture()
  try {
    const outside = path.join(root, 'outside.md')
    await writeFile(outside, '外部文件')
    await symlink(outside, path.join(agentDir, 'SYSTEM.md'))
    await assert.rejects(store.snapshot(project), /超出/)
    await rm(path.join(agentDir, 'SYSTEM.md'))
    await symlink(path.join(root, 'data'), path.join(project, '.pi', 'outside'))
    await symlink(outside, path.join(project, '.pi', 'SYSTEM.md'))
    await assert.rejects(store.snapshot(project), /超出/)
    await rm(path.join(project, '.pi', 'SYSTEM.md'))
    await rm(agentDir, { recursive: true })
    await symlink(project, agentDir)
    await assert.rejects(store.snapshot(project), /目录之外/)
    assert.equal(await readFile(outside, 'utf8'), '外部文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('原子写入失败保留原文件', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root 不受目录写权限限制')
    return
  }
  const { root, agentDir, project, store } = await fixture()
  try {
    await writeFile(path.join(agentDir, 'SYSTEM.md'), '原始正文')
    const current = (await store.snapshot(project)).entries[2].host
    await chmod(agentDir, 0o500)
    await assert.rejects(store.save({ kind: 'system', content: '新正文', revision: current.revision }))
    assert.equal(await readFile(path.join(agentDir, 'SYSTEM.md'), 'utf8'), '原始正文')
  } finally {
    await chmod(agentDir, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})

test('重载失败返回已保存结果，不回滚正文；运行中不写文件', async () => {
  const { root, agentDir, project, store } = await fixture()
  let running = false
  const restore = { sessionFile: '/test/session.jsonl' }
  const pi = {
    cwd: project,
    idle: async (action: () => Promise<unknown>) => {
      if (running) throw new Error('会话正在运行')
      return action()
    },
    captureRestoreState: async () => restore,
    reconnectModels: async (value: unknown) => {
      assert.equal(value, restore)
      throw new Error('测试重载失败')
    },
  } as unknown as PiRuntime
  const handlers = createSettingsHandlers({
    pi,
    settings: new SettingsStore(path.dirname(agentDir)),
    instructions: store,
  })
  try {
    const entry = (await handlers['settings:instructions']()).entries[0]
    running = true
    await assert.rejects(
      handlers['settings:save-instruction']({
        kind: 'agents',
        content: '运行时不能保存',
        revision: entry.host.revision,
      }),
      /运行/,
    )
    assert.equal((await store.snapshot(project)).entries[0].host.exists, false)
    running = false
    const result = await handlers['settings:save-instruction']({
      kind: 'agents',
      content: '保留保存结果',
      revision: entry.host.revision,
    })
    assert.match(result.reloadError!, /已保存，重载失败/)
    assert.equal(await readFile(path.join(agentDir, 'AGENTS.md'), 'utf8'), '保留保存结果')
    assert.equal(result.snapshot.entries[0].host.content, '保留保存结果')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('真实 Pi 会话保存指令后使用新正文，保留身份、历史、模型与思考等级', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-instructions-runtime-'))
  const agent = await useFakeAgent(root)
  const pool = new PiSessionPool(
    root,
    { connection: () => {}, event: () => {}, error: () => {}, sessionsChanged: () => {} },
    undefined,
    agent.runtimePaths,
    agent.credentials,
  )
  const store = new InstructionsStore(agent.dataRoot)
  const handlers = createSettingsHandlers({
    pi: pool,
    settings: new SettingsStore(agent.dataRoot),
    instructions: store,
  })
  try {
    await writeFile(path.join(agent.agentDir, 'AGENTS.md'), 'HOST-AGENTS-BEFORE')
    await writeFile(path.join(agent.agentDir, 'SYSTEM.md'), 'HOST-SYSTEM-BEFORE')
    await writeFile(path.join(agent.agentDir, 'APPEND_SYSTEM.md'), 'HOST-APPEND-BEFORE')
    await writeFile(path.join(root, 'AGENTS.md'), 'PROJECT-AGENTS-READONLY')
    pool.start(root)
    const key = pool.connection().sessionKey!
    async function prompt(message: string) {
      const expected = agent.provider.requests.length + 1
      await pool.prompt(key, message)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (agent.provider.requests.length >= expected && pool.getRuntimeSessions().every((record) => !record.running))
          return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('等待指令验证回复超时')
    }
    await prompt('保存前的消息')
    const initial = await pool.snapshot()
    assert.match(requestText(agent.provider.requests.at(-1)), /HOST-SYSTEM-BEFORE/)
    for (const [kind, content] of [
      ['agents', 'HOST-AGENTS-AFTER'],
      ['append-system', 'HOST-APPEND-AFTER'],
      ['system', 'HOST-SYSTEM-AFTER'],
    ] as const) {
      const entry = (await store.snapshot(root)).entries.find((item) => item.kind === kind)!
      const result = await handlers['settings:save-instruction']({ kind, content, revision: entry.host.revision })
      assert.equal(result.reloadError, undefined)
    }
    const reloaded = await pool.snapshot()
    assert.equal(reloaded.connection.sessionKey, key)
    assert.equal(reloaded.connection.sessionFile, initial.connection.sessionFile)
    assert.deepEqual(reloaded.state.model, initial.state.model)
    assert.equal(reloaded.state.thinkingLevel, initial.state.thinkingLevel)
    assert.ok(JSON.stringify(reloaded.messages).includes('保存前的消息'))
    await prompt('保存后的消息')
    const text = requestText(agent.provider.requests.at(-1))
    assert.match(text, /HOST-AGENTS-AFTER/)
    assert.match(text, /HOST-APPEND-AFTER/)
    assert.match(text, /HOST-SYSTEM-AFTER/)
    assert.match(text, /PROJECT-AGENTS-READONLY/)
    assert.doesNotMatch(text, /HOST-AGENTS-BEFORE|HOST-SYSTEM-BEFORE|HOST-APPEND-BEFORE/)
    await mkdir(path.join(root, '.pi'), { recursive: true })
    await writeFile(path.join(root, '.pi', 'SYSTEM.md'), 'PROJECT-SYSTEM-READONLY')
    await writeFile(path.join(root, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT-APPEND-READONLY')
    const system = (await store.snapshot(root)).entries[2]
    assert.equal(system.effective, 'project')
    await handlers['settings:save-instruction']({
      kind: 'system',
      content: 'HOST-IGNORED',
      revision: system.host.revision,
    })
    await prompt('项目指令验证')
    const projectText = requestText(agent.provider.requests.at(-1))
    assert.match(projectText, /PROJECT-SYSTEM-READONLY/)
    assert.match(projectText, /PROJECT-APPEND-READONLY/)
    assert.doesNotMatch(projectText, /HOST-IGNORED|HOST-APPEND-AFTER/)
    assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'PROJECT-AGENTS-READONLY')
  } finally {
    await pool.stopAndWait()
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Host 配置目录 config 为符号链接时拒绝执行，防止绕过 Host 边界', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-instructions-symlink-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'pi-instructions-outside-'))
  try {
    const configLink = path.join(root, 'config')
    await symlink(outside, configLink, 'dir')
    const store = new InstructionsStore(root)
    await assert.rejects(store.snapshot(root), /Host 配置目录不能是符号链接/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
