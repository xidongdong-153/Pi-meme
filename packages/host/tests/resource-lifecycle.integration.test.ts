import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentSummary } from '@pi-meme/contracts/collaboration'
import type { SessionSelectionResult, Snapshot } from '@pi-meme/contracts/desktop'
import type { ResourceCatalog, ResourceItem } from '@pi-meme/contracts/resources'
import { skillMarker } from '@pi-meme/contracts/skills'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { createHost } from '../src/service'

type ModelRequest = { messages: Array<{ role: string; content: unknown }> }
function skillContent(version: string) {
  return `---\nname: lifecycle\ndescription: 验证完整技能修订。\n---\n${version}技能正文\n读取 scripts/check.txt 和 references/context.md。\n`
}

async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  for (let count = 0; count < 800; count++) {
    if (await check()) return
    await delay(25)
  }
  throw new Error(message)
}

function readReply(body: ModelRequest, item: ResourceItem) {
  const start = body.messages.findLastIndex((message) => message.role === 'user')
  const step = body.messages.slice(start + 1).filter((message) => message.role === 'tool').length
  const files = [
    item.path,
    path.join(item.baseDir, 'scripts/check.txt'),
    path.join(item.baseDir, 'references/context.md'),
  ]
  return step < files.length
    ? { tool: { id: `read_${step}`, name: 'read', arguments: JSON.stringify({ path: files[step] }) } }
    : { text: '完整技能修订已读取' }
}

async function setup(reply: NonNullable<Parameters<typeof useFakeAgent>[1]>['reply']) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'host-resource-lifecycle-'))
  const fake = await useFakeAgent(temporary, { reply })
  const root = path.join(temporary, 'userData')
  const cwd = path.join(temporary, 'project')
  await mkdir(cwd)
  const host = await createHost({ dataRoot: root, credentials: fake.credentials })
  const rpc = (method: string, args: unknown[] = [], sessionId?: string) =>
    host.rpc({ requestId: crypto.randomUUID(), clientId: 'resource-lifecycle', method, args, sessionId })
  const call = async <T>(method: string, args: unknown[] = [], sessionId?: string) => {
    const result = await rpc(method, args, sessionId)
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    return result.result as T
  }
  const selection = await call<SessionSelectionResult>('workspace:select', [{ kind: 'project', cwd }])
  assert.equal(selection.cancelled, false)
  if (selection.cancelled) throw new Error('临时项目不能取消')
  const key = selection.snapshot.connection.sessionKey!
  await call('pi:access-mode', [key, 'full-access'], key)
  const catalog = await call<ResourceCatalog>('resources:import', [
    {
      kind: 'skill',
      files: [
        { path: 'SKILL.md', content: skillContent('旧版') },
        { path: 'scripts/check.txt', content: '旧版脚本' },
        { path: 'references/context.md', content: '旧版参考资料' },
      ],
    },
    cwd,
  ])
  const item = catalog.items.find((entry) => entry.name === 'lifecycle')!
  assert.ok(item)
  const update = async () => {
    const source = path.join(root, 'skills/lifecycle')
    await writeFile(path.join(source, 'scripts/check.txt'), '新版脚本')
    await writeFile(path.join(source, 'references/context.md'), '新版参考资料')
    const refreshed = await call<ResourceCatalog>('resources:catalog', [cwd])
    const revision = refreshed.items.find((entry) => entry.id === item.id)!.revision
    const saved = await call<ResourceCatalog>('resources:save-skill', [
      { id: item.id, revision, content: skillContent('新版') },
      cwd,
    ])
    const next = saved.items.find((entry) => entry.id === item.id)!
    assert.notEqual(next.revision, item.revision)
    return next
  }
  return {
    host,
    fake,
    key,
    item,
    rpc,
    call,
    update,
    snapshot: () => call<Snapshot>('pi:snapshot', [], key),
    dispose: async () => {
      await host.dispose()
      await fake.dispose()
      await rm(temporary, { recursive: true, force: true })
    },
  }
}

test('真实Worker运行和已提交队列固定完整旧修订，退役后从JSONL恢复新版', { timeout: 60000 }, async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let oldItem!: ResourceItem
  let newItem!: ResourceItem
  let first = true
  const fixture = await setup((body: ModelRequest) => {
    const latest = body.messages.findLast((message) => message.role === 'user')
    const item = JSON.stringify(latest?.content).includes('新版回合') ? newItem : oldItem
    const reply = readReply(body, item)
    if (!first) return reply
    first = false
    return { ...reply, deltaBarrier: barrier }
  })
  oldItem = fixture.item
  const reference = { id: oldItem.id, revision: oldItem.revision, name: `skill:${oldItem.name}` }
  let acquired = 0
  let released = 0
  const acquire = fixture.host.plugins.acquire.bind(fixture.host.plugins)
  fixture.host.plugins.acquire = (...args) => {
    acquired++
    const lease = acquire(...args)
    return {
      ...lease,
      release: async () => {
        released++
        await lease.release()
      },
    }
  }
  const resourceEvents: Array<Promise<Snapshot>> = []
  const unsubscribe = await fixture.host.subscribe('resource-lifecycle', (event) => {
    if (event.type === 'resources-changed') resourceEvents.push(fixture.snapshot())
  })
  try {
    await fixture.call('pi:prompt', [fixture.key, `首轮 ${skillMarker}`, undefined, [reference]], fixture.key)
    await eventually(() => fixture.fake.provider.requests.length === 1, '首轮模型请求未开始')
    await fixture.call('pi:steer', [fixture.key, `已提交插话 ${skillMarker}`, undefined, [reference]], fixture.key)
    await fixture.call('pi:follow-up', [fixture.key, `排队后续 ${skillMarker}`, undefined, [reference]], fixture.key)
    const queued = (await fixture.snapshot()).events?.find((value) => value.event.type === 'queue_update')?.event
    assert.ok(queued?.type === 'queue_update')
    assert.equal(queued.steering[0]?.submitted, true)
    assert.equal(queued.steering[0]?.skills?.[0]?.revision, oldItem.revision)
    const app = path.join(path.dirname(fixture.fake.runtimePaths.dataRoot), 'resource-only-app')
    await mkdir(path.join(app, 'dist'), { recursive: true })
    await mkdir(path.join(app, 'skills/addon'), { recursive: true })
    await writeFile(
      path.join(app, 'package.json'),
      JSON.stringify({
        name: 'resource-only-app',
        version: '1.0.0',
        piMeme: { sdkVersion: 2, ui: 'dist/ui.js', resources: { skills: ['skills/addon'] } },
      }),
    )
    await writeFile(path.join(app, 'dist/ui.js'), 'export function activate() {}')
    await writeFile(
      path.join(app, 'skills/addon/SKILL.md'),
      '---\nname: addon\ndescription: 包内技能。\n---\n包内正文\n',
    )
    await fixture.host.plugins.loadDirectory(app)
    const active = await fixture.snapshot()
    assert.equal(
      active.uiPlugins?.some((plugin) => plugin.id === 'resource-only-app'),
      false,
    )
    assert.equal(
      active.state.resourceSnapshot?.skills.some((skill) => skill.owner.id === 'resource-only-app'),
      false,
    )
    newItem = await fixture.update()
    assert.equal(released, 0, '运行中任务和队列仍应持有旧Worker租约')
    release()
    await eventually(() => released === 1, '队列结束后旧Worker没有退役')
    await eventually(async () => {
      const snapshots = await Promise.all(resourceEvents)
      return snapshots.some(
        (snapshot) =>
          !snapshot.state.resourceSnapshot &&
          snapshot.uiPlugins?.some((plugin) => plugin.id === 'resource-only-app') === true,
      )
    }, '退役完成事件没有提供清除旧快照和新App UI的状态')
    const oldRequests = fixture.fake.provider.requests as ModelRequest[]
    const oldText = JSON.stringify(oldRequests)
    assert.ok(oldText.includes('旧版脚本'))
    assert.ok(oldText.includes('旧版参考资料'))
    assert.equal(oldText.includes('新版技能正文'), false)
    for (const tag of ['已提交插话', '排队后续']) {
      const message = oldRequests
        .flatMap((body) => body.messages)
        .find((entry) => entry.role === 'user' && JSON.stringify(entry.content).includes(tag))
      assert.ok(message)
      assert.ok(JSON.stringify(message.content).includes(oldItem.path))
      assert.ok(JSON.stringify(message.content).includes('旧版技能正文'))
    }
    const before = await fixture.snapshot()
    const sessionFile = before.connection.sessionFile!
    assert.ok(sessionFile)
    const previousRequests = fixture.fake.provider.requests.length
    await fixture.call(
      'pi:prompt',
      [fixture.key, `新版回合 ${skillMarker}`, undefined, [{ ...reference, revision: newItem.revision }]],
      fixture.key,
    )
    await eventually(async () => (await fixture.snapshot()).agent?.status === 'completed', '新版回合没有结束')
    const after = await fixture.snapshot()
    assert.equal(after.connection.sessionFile, sessionFile)
    assert.equal(acquired, 2)
    const requests = fixture.fake.provider.requests.slice(previousRequests) as ModelRequest[]
    assert.ok(JSON.stringify(requests).includes('新版脚本'))
    assert.ok(JSON.stringify(requests).includes('新版参考资料'))
    assert.ok(JSON.stringify(requests).includes('已提交插话'), '重建Worker应恢复原生会话历史')
    const entries = (await readFile(sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const snapshots = entries.filter((entry) => entry.customType === 'pi-meme.resource-snapshot')
    assert.equal(snapshots.length, 2)
    assert.equal(
      snapshots[0].data.skills.find((item: { id: string }) => item.id === oldItem.id).revision,
      oldItem.revision,
    )
    assert.equal(
      snapshots[1].data.skills.find((item: { id: string }) => item.id === oldItem.id).revision,
      newItem.revision,
    )
    const stale = await fixture.rpc(
      'pi:prompt',
      [fixture.key, `过期选择 ${skillMarker}`, undefined, [reference]],
      fixture.key,
    )
    assert.match(stale.error?.message ?? '', /技能版本已变化|重新选择/)
    assert.equal(fixture.fake.provider.requests.length, previousRequests + requests.length)
  } finally {
    release()
    unsubscribe()
    await fixture.dispose()
  }
})

test('fork none子Worker在Host更新后仍继承父资源修订及读取来源', { timeout: 60000 }, async () => {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let item!: ResourceItem
  let spawned = false
  const childRequests: ModelRequest[] = []
  const fixture = await setup((body: ModelRequest) => {
    const firstUser = body.messages.find((message) => message.role === 'user')
    if (JSON.stringify(firstUser?.content).includes('独立资源子任务')) {
      childRequests.push(body)
      return readReply(body, item)
    }
    if (!spawned) {
      spawned = true
      return {
        deltaBarrier: barrier,
        tool: {
          name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'resource_reader', message: '独立资源子任务', fork_turns: 'none' }),
        },
      }
    }
    return { text: '父任务已完成' }
  })
  item = fixture.item
  try {
    await fixture.call('pi:prompt', [fixture.key, '父任务的独有历史标记'], fixture.key)
    await eventually(() => fixture.fake.provider.requests.length === 1, '父请求未开始')
    const updated = await fixture.update()
    release()
    await eventually(async () => {
      const agents = await fixture.call<AgentSummary[]>('pi:agents', [fixture.key])
      return agents.some((agent) => agent.depth === 1 && agent.status === 'completed')
    }, '子任务没有完成')
    const agents = await fixture.call<AgentSummary[]>('pi:agents', [fixture.key])
    const child = agents.find((agent) => agent.depth === 1)!
    assert.ok(child.sessionFile)
    const childText = JSON.stringify(childRequests)
    assert.ok(childText.includes(item.path))
    assert.ok(childText.includes('旧版脚本'))
    assert.ok(childText.includes('旧版参考资料'))
    assert.equal(childText.includes(updated.path), false)
    assert.equal(childText.includes('父任务的独有历史标记'), false)
    const entries = (await readFile(child.sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const snapshot = entries.find((entry) => entry.customType === 'pi-meme.resource-snapshot')
    assert.equal(snapshot.data.skills.find((entry: { id: string }) => entry.id === item.id).revision, item.revision)
    const usage = entries.find((entry) => entry.customType === 'pi-meme.skill-use')
    assert.equal(usage.data.path, item.path)
    assert.equal(usage.data.revision, item.revision)
    assert.equal(usage.data.source, 'implicit-read')
  } finally {
    release()
    await fixture.dispose()
  }
})
