import assert from 'node:assert/strict'
import { test } from 'vitest'
import { skillMessageParts, skillMessageText } from '../src/skills'

const expanded =
  '123 <skill name="typescript" location="/skills/typescript/SKILL.md">\n正文\n</skill> 与 <skill name="review-code" location="/skills/review-code/SKILL.md">\n正文\n</skill>\n看看技能'

test('技能消息摘要隐藏技能正文并保留前后文字与换行', () => {
  assert.deepEqual(
    skillMessageParts(expanded).map((part) => (part.type === 'skill' ? part.name : part.text)),
    ['123 ', 'typescript', ' 与 ', 'review-code', '\n看看技能'],
  )
  assert.equal(skillMessageText(expanded), '123 $typescript 与 $review-code\n看看技能')
})

test('重复技能块可独立识别，无效技能块按普通文本保留', () => {
  const repeated =
    '<skill name="typescript" location="/a">\nx\n</skill><skill name="typescript" location="/a">\nx\n</skill>'
  assert.equal(skillMessageParts(repeated).filter((part) => part.type === 'skill').length, 2)
  assert.deepEqual(skillMessageParts('普通文本 <skill>不是有效技能块</skill>'), [
    { type: 'text', text: '普通文本 <skill>不是有效技能块</skill>' },
  ])
})
