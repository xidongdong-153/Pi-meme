import assert from 'node:assert/strict'
import { test } from 'vitest'
import { builtinCommands } from '../src/pi'
import { normalizePlanMessage } from '../src/plan'
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
