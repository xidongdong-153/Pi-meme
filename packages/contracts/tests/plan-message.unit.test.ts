import assert from 'node:assert/strict'
import { test } from 'vitest'
import { builtinCommands } from '../src/pi'
import { normalizePlanMessage, projectBranchPlans } from '../src/plan'
import { messageOptions } from '../src/ipc'

test('计划候选仅注册 canonical plan，原有命令保持', () => {
  assert.deepEqual(
    builtinCommands.map((command) => command.name),
    ['plan', 'goal', 'compact', 'name'],
  )
})

test('完整中文计划命令只在首 token 生效，正文与换行保留', () => {
  for (const alias of ['plan', '计划', '计划模式']) {
    assert.deepEqual(normalizePlanMessage(` /${alias}`, 'default'), {
      text: '',
      mode: 'plan',
      commandOnly: true,
    })
    assert.deepEqual(normalizePlanMessage(` /${alias}\n任务正文`, 'default'), {
      text: '任务正文',
      mode: 'plan',
      commandOnly: false,
    })
    for (const text of [`正文 /${alias}`, `/${alias}.md`, `/${alias}中`])
      assert.deepEqual(normalizePlanMessage(text, 'default'), { text, mode: 'default', commandOnly: false })
  }
})

test('计划引用必须带修订并匹配实施或调整模式', () => {
  const reference = { id: 'plan', revision: 2 }
  assert.deepEqual(messageOptions({ mode: 'default', plan: { intent: 'execute', reference } }), {
    mode: 'default',
    plan: { intent: 'execute', reference },
  })
  assert.throws(() => messageOptions({ mode: 'plan', plan: { intent: 'execute', reference } }), /计划引用/)
  assert.throws(
    () => messageOptions({ mode: 'plan', plan: { intent: 'revise', reference: { id: 'plan', revision: 0 } } }),
    /计划引用/,
  )
})

test('计划从原生活动分支恢复，忽略失败、损坏和其他分支，支持回退', () => {
  const document = {
    id: 'plan',
    sessionId: 'session',
    runId: 'run',
    revision: 1,
    title: '原方案',
    markdown: '# 原方案',
    updatedAt: '2026-10-26T00:00:00Z',
  }
  const saved = (id: string, parentId: string, details: unknown, isError = false) => ({
    id,
    parentId,
    type: 'message',
    message: { role: 'toolResult', toolName: 'save_plan', details, isError },
  })
  const entries = [
    { id: 'user', parentId: null, type: 'message', message: { role: 'user' } },
    saved('first', 'user', document),
    { id: 'adjust', parentId: 'first', type: 'message', message: { role: 'user' } },
    saved('second', 'adjust', { ...document, revision: 2, markdown: '# 调整后' }),
    saved('failed', 'second', document, true),
    saved('broken', 'failed', { id: 'broken' }),
    saved('other', 'user', { ...document, markdown: '# 另一分支' }),
  ]
  assert.deepEqual(
    projectBranchPlans(entries, 'broken').map((item) => item.sourceEntryId),
    ['first', 'second'],
  )
  assert.equal(projectBranchPlans(entries, 'adjust').at(-1)?.document.markdown, '# 原方案')
  assert.deepEqual(projectBranchPlans(entries, 'user'), [])
  assert.equal(projectBranchPlans(entries, 'other').at(-1)?.document.markdown, '# 另一分支')
})
