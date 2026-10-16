import assert from 'node:assert/strict'
import { test } from 'vitest'
import { skillMarker } from '@pi-meme/contracts/skills'
import { appendSkillInvocation } from '../src/settings/invoke-skill'

test('设置唤起系统技能时在草稿末尾插入技能标记，创建插件还带上提示语', () => {
  assert.equal(appendSkillInvocation(''), `${skillMarker} `)
  assert.equal(appendSkillInvocation('已有草稿'), `已有草稿 ${skillMarker} `)
  assert.equal(appendSkillInvocation('已有草稿 '), `已有草稿 ${skillMarker} `)
  assert.equal(appendSkillInvocation('', '帮我创建一个插件'), `${skillMarker} 帮我创建一个插件`)
})
