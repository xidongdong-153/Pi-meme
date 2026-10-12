import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builtinCommands } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { prepareComposerMessage, planCompletion, sendQueueMode } from '../src/ui/composer/plan-input'
import { SessionMode } from '../src/ui/composer/session-mode'
import { applyEvent, emptyChat } from '../src/ui/model/state'
import type { PlanDocument } from '@pi-meme/contracts/plan'

for (const alias of ['plan', '计划', '计划模式']) {
  test(`${alias} 只识别首完整命令，纯命令保留技能占位并不发送`, () => {
    assert.deepEqual(prepareComposerMessage(` /${alias}  任务正文`, 'default'), {
      text: '任务正文',
      mode: 'plan',
      commandOnly: false,
    })
    assert.equal(prepareComposerMessage(`/${alias} ${skillMarker}`, 'default').commandOnly, true)
    assert.equal(prepareComposerMessage(`/${alias}`, 'default').commandOnly, true)
    assert.equal(prepareComposerMessage(`内容 /${alias}`, 'default').mode, 'default')
    assert.equal(prepareComposerMessage(`/${alias}.md`, 'default').mode, 'default')
    const command = builtinCommands.find((entry) => entry.name === 'plan')!
    assert.equal(planCompletion(command, `/${alias} 保留正文`, 0, alias.length + 1), '/plan 保留正文')
    assert.equal(planCompletion(command, `正文 /${alias}`, 3, alias.length + 4), undefined)
  })
}
test('旧builtin中文候选按canonical plan接受，外部同名命令不触发计划', () => {
  for (const name of ['plan', '计划', '计划模式']) {
    const command = { ...builtinCommands[0], name }
    assert.equal(planCompletion(command, `/${name} 正文`, 0, name.length + 1), '/plan 正文')
    assert.equal(planCompletion({ ...command, source: 'extension' }, `/${name}`, 0, name.length + 1), undefined)
  }
})
test('planet 不触发规划，发送保留会话模式，跨模式运行只能排队', () => {
  assert.equal(prepareComposerMessage('/planet', 'default').mode, 'default')
  assert.equal(prepareComposerMessage('任务', 'plan').mode, 'plan')
  assert.equal(sendQueueMode(true, 'steering', 'plan', 'default'), 'followUp')
  assert.equal(sendQueueMode(true, 'steering', 'default', 'plan'), 'followUp')
  assert.equal(sendQueueMode(true, 'steering', 'plan', 'plan'), 'steering')
  assert.equal(sendQueueMode(false, 'steering', 'plan'), 'prompt')
})
test('模式写入期间保留选择，迟到快照和失败不能覆盖随后关闭；新读取接受Host', () => {
  const state = new SessionMode()
  assert.equal(state.snapshot('A', 'default', state.revision), 'default')
  const read = state.revision
  const first = state.change('A', 'plan')
  const second = state.change('A', 'default')
  state.settled('A', first)
  assert.equal(state.snapshot('A', 'plan', read), 'default')
  assert.equal(state.snapshot('A', 'plan', state.revision), 'default')
  state.settled('A', second)
  assert.equal(state.snapshot('A', 'plan', state.revision), 'plan')
  assert.equal(state.snapshot('B', 'default', state.revision), 'default')
  assert.equal(state.snapshot('A', 'plan', state.revision), 'plan')
})
test('只有保存ACK生成计划卡片，同文档更新版次、旧ACK不覆盖，新文档保留', () => {
  const document: PlanDocument = {
    id: 'doc',
    sessionId: 'A',
    runId: 'run',
    revision: 1,
    title: '计划',
    markdown: '第一版',
    updatedAt: '2026-10-10T00:00:00Z',
  }
  assert.equal(emptyChat.planDocuments, undefined)
  const first = applyEvent(emptyChat, { type: 'plan_saved', document })
  const next = applyEvent(first, { type: 'plan_saved', document: { ...document, revision: 2, markdown: '第二版' } })
  assert.equal(applyEvent(next, { type: 'plan_saved', document }), next)
  const withSecond = applyEvent(next, { type: 'plan_saved', document: { ...document, id: 'next' } })
  assert.deepEqual(
    withSecond.planDocuments?.map((entry) => entry.markdown),
    ['第二版', '第一版'],
  )
})

test('撤回队列逐条恢复模式、图片和技能，不合并不同模式消息', async () => {
  const { queuedDraft } = await import('../src/ui/composer/restore-queued-input')
  const skill = {
    ...builtinCommands[0],
    name: 'skill:verify',
    source: 'skill' as const,
    resourceId: 'verify-id',
    resourceRevision: 'r1',
  }
  const input = {
    id: 'queue',
    text: '检查文件',
    mode: 'plan' as const,
    skills: [{ name: 'skill:verify', id: 'verify-id', revision: 'r1' }],
    images: [{ type: 'image' as const, data: 'fake-image', mimeType: 'image/png' }],
  }
  const restored = queuedDraft(input, [skill])
  assert.equal(restored.mode, 'plan')
  assert.equal(restored.selectedSkills[0], skill)
  assert.ok(restored.draft.includes(skillMarker))
  assert.equal(restored.attachments[0].data, 'fake-image')
  assert.equal(restored.attachments[0].mimeType, 'image/png')
  assert.ok(restored.attachments[0].id)
  assert.equal(queuedDraft({ ...input, mode: 'default' }, [skill]).mode, 'default')
  assert.ok(queuedDraft(input, []).draft.includes('$verify'))
})

test('队列技能恢复保留插入位置和重复引用，旧修订原位置转文字', async () => {
  const { queuedDraft } = await import('../src/ui/composer/restore-queued-input')
  const skill = {
    ...builtinCommands[0],
    name: 'skill:verify',
    source: 'skill' as const,
    resourceId: 'verify-id',
    resourceRevision: 'r1',
  }
  const input = {
    id: 'queue',
    text: `${skillMarker} 前文 ${skillMarker} 后文`,
    mode: 'default' as const,
    skills: [
      { name: skill.name, id: skill.resourceId, revision: 'r1' },
      { name: skill.name, id: skill.resourceId, revision: 'r1' },
    ],
  }
  const restored = queuedDraft(input, [skill])
  assert.equal(restored.draft, input.text)
  assert.deepEqual(restored.selectedSkills, [skill, skill])
  const expired = queuedDraft(input, [{ ...skill, resourceRevision: 'r2' }])
  assert.equal(expired.draft, '$verify 前文 $verify 后文')
  assert.deepEqual(expired.selectedSkills, [])
})
