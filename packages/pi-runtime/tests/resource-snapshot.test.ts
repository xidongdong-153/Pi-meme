import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ResourceItem, ResourceSnapshot } from '@pi-meme/contracts/resources'
import type { PiEvent } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { SdkSession } from '../src/sdk/session'
import { branchSkillUsages, skillUsageEntry } from '../src/extensions/skill-usage'
import { readSessionHistory } from '../src/session-history'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

function item(file: string, kind: 'skill' | 'extension', name: string): ResourceItem {
  return {
    id: `host:${name}`,
    kind,
    name,
    description: `${name} 使用说明`,
    revision: 'rev-1',
    path: file,
    sourcePath: file,
    baseDir: path.dirname(file),
    scope: 'host',
    owner: { id: 'test-package', type: 'pi-package' },
    enabled: true,
    defaultPolicy: { enabled: true, invocation: 'automatic' },
    invocation: 'automatic',
    diagnostics: [],
    editable: true,
  }
}

async function settled(session: SdkSession) {
  const deadline = Date.now() + 10000
  while ((await session.snapshot()).state.isStreaming) {
    if (Date.now() > deadline) throw new Error('资源测试等待会话结束超时')
    await delay(10)
  }
}

test('snapshot 同时限制技能、扩展预加载和动态发现，原生调用记录可恢复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-resources-snapshot-'))
  const skillFile = path.join(root, 'frozen', 'automatic', 'SKILL.md')
  const manualFile = path.join(root, 'frozen', 'manual', 'SKILL.md')
  const extra = path.join(root, 'outside', 'SKILL.md')
  const prompt = path.join(root, 'outside', 'dynamic.md')
  const marker = path.join(root, 'legacy-ran')
  const legacyExtension = path.join(root, '.pi', 'extensions', 'legacy.js')
  const approved = path.join(root, 'frozen', 'extension.js')
  const fake = await useFakeAgent(root, {
    reply: (_body, index) =>
      index === 1 ? { tool: { name: 'read', arguments: JSON.stringify({ path: skillFile }) } } : '已完成资源检查',
  })
  await Promise.all(
    [skillFile, manualFile, extra, legacyExtension].map((file) => mkdir(path.dirname(file), { recursive: true })),
  )
  await writeFile(skillFile, '---\nname: automatic\ndescription: 自动技能\n---\n\n按需读取的完整技能正文。')
  await writeFile(manualFile, '---\nname: manual\ndescription: 手动技能\n---\n\n手动技能正文。')
  await writeFile(extra, '---\nname: outside\ndescription: 不允许发现的技能\n---\n\n不可加入清单。')
  await writeFile(prompt, '---\ndescription: 动态提示词\n---\n动态提示词正文')
  await writeFile(
    legacyExtension,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {}`,
  )
  await writeFile(
    approved,
    `export default pi => { pi.registerCommand('approved', {handler:async()=>{}}); pi.on('resources_discover',()=>({skillPaths:[${JSON.stringify(extra)}],promptPaths:[${JSON.stringify(prompt)}]})) }`,
  )
  await writeFile(
    path.join(fake.agentDir, 'settings.json'),
    JSON.stringify({
      extensions: [legacyExtension],
      packages: ['uninstalled-test-package'],
      compaction: { keepRecentTokens: 1, reserveTokens: 100 },
    }),
  )
  const snapshot: ResourceSnapshot = {
    id: 'snapshot-1',
    generation: 4,
    cwd: root,
    skills: [item(skillFile, 'skill', 'automatic'), { ...item(manualFile, 'skill', 'manual'), invocation: 'manual' }],
    extensions: [item(approved, 'extension', 'approved')],
  }
  const errors: string[] = []
  const session = new SdkSession(
    root,
    { connection: () => {}, event: () => {}, error: (value) => errors.push(value.message) },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    { resourceSnapshot: snapshot },
  )
  try {
    session.start(root)
    const commands = await session.getCommands()
    assert.deepEqual(
      commands.filter((command) => command.source === 'skill').map((command) => command.name),
      ['skill:automatic', 'skill:manual'],
    )
    assert.ok(commands.some((command) => command.name === 'approved'))
    assert.equal(commands.find((command) => command.name === 'skill:manual')?.invocation, 'manual')
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.ok(errors.some((message) => message.includes('动态技能路径未加载')))
    assert.ok(commands.some((command) => command.name === 'dynamic'))
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('使用自动技能')
    await settled(session)
    const firstRequest = requestText(fake.provider.requests[0])
    assert.match(firstRequest, /<name>automatic<\/name>/)
    assert.doesNotMatch(firstRequest, /<name>manual<\/name>|按需读取的完整技能正文/)
    const ref = { name: 'skill:manual', id: 'host:manual', revision: 'rev-1' }
    await session.prompt(`${skillMarker} 处理手动任务`, undefined, [ref])
    await settled(session)
    const journal = (await session.getEntries()).entries.filter(
      (entry) => entry.type === 'custom' && entry.customType === skillUsageEntry,
    )
    assert.equal(journal.length, 2)
    assert.equal((await session.snapshot()).state.skillUsages?.length, 2)
    const persisted = await readSessionHistory(session.getActiveSession().sessionFile!)
    assert.equal(persisted.skillUsages?.length, 2)
    assert.deepEqual(
      journal.map((entry) => (entry.type === 'custom' ? (entry.data as { source: string }).source : '')),
      ['implicit-read', 'explicit'],
    )
    await session.prompt('/compact')
    await settled(session)
    await session.prompt('继续适用的技能')
    await settled(session)
    assert.match(requestText(fake.provider.requests.at(-1)), /当前分支已使用以下技能/)
    const restore = await session.captureRestoreState()
    await session.reconnectModels(restore)
    await session.prompt('恢复后继续')
    await settled(session)
    assert.match(requestText(fake.provider.requests.at(-1)), /当前分支已使用以下技能/)
    assert.ok((await readFile(session.getActiveSession().sessionFile!, 'utf8')).includes(skillUsageEntry))
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('工具与注册的 custom renderer 来源写入 JSONL，历史不改原生 details', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-resource-source-'))
  const entry = path.join(root, 'entry.js')
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'owned-tool', arguments: '{}' } } : '来源验证完成'),
  })
  await writeFile(
    entry,
    `export default pi => { pi.registerMessageRenderer('owned-message', () => undefined); pi.registerTool({name:'owned-tool',label:'测试',description:'测试资源来源',parameters:{type:'object',properties:{}},execute:async()=>{ pi.sendMessage({customType:'owned-message',content:'资源消息',display:true}); return {content:[{type:'text',text:'资源工具'}],details:{original:true}} }}) }`,
  )
  const snapshot: ResourceSnapshot = {
    id: 'source-snapshot',
    generation: 7,
    cwd: root,
    skills: [],
    extensions: [item(entry, 'extension', 'owned')],
  }
  const events: PiEvent[] = []
  const session = new SdkSession(
    root,
    { connection: () => {}, error: () => {}, event: ({ event }) => events.push(event as PiEvent) },
    fake.runtimePaths,
    fake.credentials,
    undefined,
    { resourceSnapshot: snapshot },
  )
  try {
    session.start(root)
    await session.snapshot()
    await session.setModel({ provider: 'fake', id: 'first' })
    await session.prompt('验证来源')
    await settled(session)
    const tool = events.find((event) => event.type === 'tool_execution_end')
    assert.equal(tool && 'source' in tool ? tool.source?.ownerId : undefined, 'test-package')
    const messages = (await session.snapshot()).messages
    const result = messages.find((message) => message.role === 'toolResult')
    assert.equal(result?.source?.generation, 7)
    assert.deepEqual(result?.role === 'toolResult' ? result.details : undefined, { original: true })
    const custom = messages.find((message) => message.role === 'custom' && message.customType === 'owned-message')
    assert.equal(custom?.source?.ownerId, 'test-package')
    const history = await readSessionHistory(session.getActiveSession().sessionFile!)
    const reply = messages.find((message) => message.role === 'assistant')
    assert.ok(reply?.completedAt !== undefined && reply.completedAt >= reply.timestamp)
    const liveReply = events.find(
      (event) =>
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        event.message.timestamp === reply.timestamp,
    )
    assert.ok(liveReply?.type === 'message_end' && liveReply.message.completedAt !== undefined)
    assert.ok(liveReply.message.completedAt >= reply.timestamp)
    assert.deepEqual(
      history.messages.find((message) => message.role === 'assistant' && message.timestamp === reply.timestamp),
      reply,
    )
    const historyCustom = history.messages.find(
      (message) => message.role === 'custom' && message.customType === 'owned-message',
    )
    assert.equal(historyCustom?.source?.ownerId, 'test-package')
  } finally {
    await session.stopAndWait()
    await fake.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('技能使用投影分开保留继承、自身和显式、隐式调用，同组保留最近一次', () => {
  const data = {
    id: 'skill-id',
    revision: 'revision',
    name: 'skill:test',
    path: '/frozen/SKILL.md',
  }
  const entry = (id: string, source: 'explicit' | 'implicit-read', toolCallId?: string): SessionEntry => ({
    type: 'custom',
    id,
    parentId: null,
    timestamp: '2026-10-12T00:00:00Z',
    customType: skillUsageEntry,
    data: { ...data, source, toolCallId },
  })
  const inherited = entry('parent', 'explicit')
  const own = entry('child', 'implicit-read', 'first-read')
  const latestOwn = entry('child-latest', 'implicit-read', 'latest-read')
  const usages = branchSkillUsages([inherited, own, latestOwn], ['parent'])
  assert.deepEqual(
    usages.map(({ inherited, source }) => ({ inherited, source })),
    [
      { inherited: true, source: 'explicit' },
      { inherited: false, source: 'implicit-read' },
    ],
  )
  assert.equal(usages[1]?.toolCallId, 'latest-read')
  assert.deepEqual(
    branchSkillUsages([own, inherited], ['parent']).map(({ inherited, source }) => ({ inherited, source })),
    [
      { inherited: false, source: 'implicit-read' },
      { inherited: true, source: 'explicit' },
    ],
  )
  assert.deepEqual(
    branchSkillUsages([entry('parent-read', 'implicit-read'), own], ['parent-read']).map((usage) => usage.inherited),
    [true, false],
  )
  const root = branchSkillUsages([entry('root-explicit', 'explicit'), entry('root-read', 'implicit-read')])
  assert.deepEqual(
    root.map(({ inherited, source }) => ({ inherited, source })),
    [
      { inherited: false, source: 'explicit' },
      { inherited: false, source: 'implicit-read' },
    ],
  )
})
