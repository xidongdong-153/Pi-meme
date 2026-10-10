import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builtinCommands } from '../src/pi'
import { normalizePlanMessage } from '../src/plan'

test('计划候选仅注册 canonical plan，原有命令保持', () => {
  assert.deepEqual(
    builtinCommands.map((command) => command.name),
    ['plan', 'compact', 'name'],
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
