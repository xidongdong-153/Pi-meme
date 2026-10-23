import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ComposerSnapshot } from '@pi-meme/chat/ui/use-chat-session'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { ComposerDrafts, composerDraftPrefix } from '../src/session/composer-drafts'

function fixture() {
  const values = new Map<string, string>()
  const storage = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  })
  return {
    values,
    storage,
    open: (hostId = 'host-a') => {
      const drafts = new ComposerDrafts(hostId, storage)
      drafts.bind('session', 'session')
      return drafts
    },
  }
}

const skill: PiSlashCommand = {
  name: 'skill:review',
  source: 'skill',
  resourceId: 'review',
  resourceRevision: 'r1',
  sourceInfo: { path: '/skills/review/SKILL.md', source: 'host', scope: 'user', origin: 'top-level' },
}
const empty: ComposerSnapshot = { draft: '', selectedSkills: [], attachments: [], queueMode: 'followUp' }
const composer: ComposerSnapshot = {
  ...empty,
  draft: `${skillMarker} 检查文件`,
  selectedSkills: [skill],
  attachments: [{ id: 'image', type: 'image', mimeType: 'image/png', data: '不应保存的图片数据' }],
}

test('刷新恢复文字与技能引用，Host和会话分别隔离，图片不写入存储', () => {
  const { open, values } = fixture()
  const drafts = open()
  drafts.set('session', composer)
  assert.equal(drafts.get('session'), composer, '窗口内保留原附件')
  assert.equal(drafts.hasUnstoredInput(), true, '图片未落盘，离开时需要确认')
  assert.deepEqual(open().get('session'), { ...composer, attachments: [] })
  assert.equal(open('host-b').get('session'), undefined)
  assert.equal(open().get('other'), undefined)
  assert.doesNotMatch([...values.values()].join(''), /不应保存的图片数据|attachments/)
})

test('目标草稿只保存创建标记，旧预算设置读取后移除', () => {
  const { open, values } = fixture()
  const key = composerDraftPrefix + JSON.stringify(['host-a', 'session'])
  values.set(key, JSON.stringify({ ...empty, draft: '已有目标草稿', goalDraft: { budget: '1214' } }))
  const drafts = open()
  const restored = drafts.get('session')!
  assert.equal(restored.goalDraft, true)
  assert.equal(restored.draft, '已有目标草稿')
  drafts.set('session', restored)
  assert.equal(JSON.parse(values.get(key)!).goalDraft, true)
  assert.doesNotMatch(values.get(key)!, /budget|1214/)
})

test('Host重启改变运行时key后，仍按稳定会话ID恢复；迟到身份不覆盖新输入', () => {
  const { storage } = fixture()
  const previous = new ComposerDrafts('host-a', storage)
  previous.bind('old-runtime', 'stable-session')
  previous.set('old-runtime', composer)
  const restarted = new ComposerDrafts('host-a', storage)
  restarted.set('new-runtime', empty)
  assert.equal(restarted.bind('new-runtime', 'stable-session')?.draft, composer.draft)
  const typing = new ComposerDrafts('host-a', storage)
  typing.set('another-runtime', { ...empty, draft: '已经输入的新内容' })
  assert.equal(typing.bind('another-runtime', 'stable-session'), undefined)
  assert.equal(typing.get('another-runtime')?.draft, '已经输入的新内容')
})

test('请求返回前输入框清空也保留待发送草稿，成功后删除', () => {
  const { open } = fixture()
  const drafts = open()
  drafts.set('session', composer)
  const finish = drafts.startSend('session', composer)
  drafts.set('session', empty)
  assert.equal(drafts.hasUnstoredInput(), true, '请求中的图片仍未落盘')
  assert.equal(open().get('session')?.draft, composer.draft)
  finish()
  assert.equal(open().get('session'), undefined)
})

test('发送失败恢复原草稿，成功返回不删除等待期间输入的新草稿', () => {
  for (const draft of [composer, { ...empty, draft: '等待期间的新草稿' }]) {
    const { open } = fixture()
    const drafts = open()
    const finish = drafts.startSend('session', composer)
    drafts.set('session', empty)
    drafts.set('session', draft)
    finish()
    assert.equal(open().get('session')?.draft, draft.draft)
  }
})

test('并行发送分别释放，删除会话后的迟到请求不恢复草稿', () => {
  const { open } = fixture()
  const drafts = open()
  const finishFirst = drafts.startSend('session', composer)
  const second = { ...empty, draft: '第二条消息' }
  const finishSecond = drafts.startSend('session', second)
  drafts.set('session', empty)
  finishFirst()
  assert.equal(open().get('session')?.draft, second.draft)
  drafts.delete('session')
  finishSecond()
  assert.equal(open().get('session'), undefined)
})

test('跨服务转移清空草稿后，同一会话继续输入仍可持久化', () => {
  const { open } = fixture()
  const drafts = open()
  drafts.set('session', composer)
  drafts.delete('session')
  drafts.set('session', { ...empty, draft: '转移后重新输入的草稿' })
  assert.equal(open().get('session')?.draft, '转移后重新输入的草稿')
})

test('历史消息编辑不覆盖普通草稿，清空文字后不恢复技能标记', () => {
  const { open } = fixture()
  const drafts = open()
  drafts.set('session', { ...composer, draft: '历史消息修改', editing: { entryId: 'entry-1000', restore: composer } })
  assert.equal(open().get('session')?.draft, composer.draft)
  drafts.set('session', { ...composer, draft: '' })
  assert.equal(open().get('session'), undefined)
})

test('存储维护检查所有会话的已保存草稿、技能与发送中的输入', () => {
  const { open } = fixture()
  const drafts = open()
  drafts.set('session', empty)
  assert.equal(drafts.hasInput(), false)
  drafts.set('other-session', { ...empty, draft: '另一个会话的草稿' })
  assert.equal(drafts.hasInput(), true)
  drafts.delete('other-session')
  drafts.set('session', { ...empty, selectedSkills: [skill] })
  assert.equal(drafts.hasInput(), true)
  drafts.set('session', { ...empty, editing: { entryId: 'entry-1', restore: empty } })
  assert.equal(drafts.hasInput(), true)
  drafts.set('session', empty)
  const finish = drafts.startSend('session', composer)
  assert.equal(drafts.hasInput(), true)
  finish()
  assert.equal(drafts.hasInput(), false)
})

test('待发送插件引用只保存 ID，空正文可恢复，发送成功后不再显示旧引用', () => {
  const { open, values } = fixture()
  const drafts = open()
  const pending = { ...empty, pluginMentions: ['cloud'] }
  drafts.set('session', pending)
  assert.equal(drafts.hasInput(), true)
  assert.deepEqual(open().get('session'), pending)
  assert.doesNotMatch([...values.values()].join(''), /agentPlugins|capabilities|enabled/)
  const finish = drafts.startSend('session', { ...pending, draft: '调用插件' })
  drafts.set('session', empty)
  assert.deepEqual(open().get('session')?.pluginMentions, ['cloud'])
  finish()
  assert.equal(open().get('session'), undefined)
  drafts.set('session', { ...empty, draft: '后续消息' })
  assert.equal(open().get('session')?.pluginMentions, undefined)
})

test('损坏、旧结构和无效技能不会导致恢复崩溃；存储被禁用时窗口内仍可切换草稿', () => {
  const { values, open } = fixture()
  const key = composerDraftPrefix + JSON.stringify(['host-a', 'session'])
  for (const value of [
    '{',
    'null',
    '{}',
    JSON.stringify({ ...composer, selectedSkills: [{}] }),
    JSON.stringify({ ...empty, pluginMentions: [{}] }),
  ]) {
    values.set(key, value)
    assert.equal(open().get('session'), undefined)
  }
  const drafts = new ComposerDrafts('host-a', () => {
    throw new Error('浏览器禁用存储')
  })
  assert.equal(drafts.get('session'), undefined)
  drafts.bind('session', 'session')
  drafts.set('session', { ...composer, attachments: [] })
  assert.equal(drafts.hasUnstoredInput(), true)
  drafts.set('session', composer)
  assert.equal(drafts.get('session'), composer)
  drafts.delete('session')
  assert.equal(drafts.get('session'), undefined)
})
