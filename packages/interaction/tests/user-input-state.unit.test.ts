import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PiUserInputRequest } from '@pi-meme/contracts/user-input'
import {
  collectQuestionAnswers,
  createQuestionDraft,
  questionAnswer,
  selectQuestionOption,
  writeQuestionDraft,
} from '../src/ui/user-input-state'

const request: PiUserInputRequest = {
  type: 'extension_ui_request',
  id: 'request-1',
  method: 'questions',
  questions: [
    {
      id: 'framework',
      question: '使用哪个框架？',
      options: [{ label: 'React', description: '沿用现有界面' }, { label: 'Vue' }],
    },
    { id: 'scope', question: '需要处理哪些页面？' },
    { id: 'deadline', question: '何时完成？', options: [{ label: '今天' }, { label: '本周' }] },
  ],
}

test('未回答和空白输入不生成答案，选中后仍等待统一发送', () => {
  const drafts = request.questions.map(createQuestionDraft)
  assert.equal(questionAnswer(request.questions[0], drafts[0]), undefined)
  assert.equal(questionAnswer(request.questions[1], writeQuestionDraft(drafts[1], ' \n ')), undefined)
  drafts[0] = selectQuestionOption(1)
  assert.deepEqual(questionAnswer(request.questions[0], drafts[0]), { id: 'framework', value: 'Vue' })
  assert.equal(collectQuestionAnswers(request.questions, drafts), undefined)
})

test('自由填写优先且取消选中，清空不会恢复旧选项；再次选择清空自填', () => {
  const draft = writeQuestionDraft(selectQuestionOption(0), '  Svelte\nKit  ')
  assert.equal(draft.selectedIndex, null)
  assert.deepEqual(questionAnswer(request.questions[0], draft), { id: 'framework', value: 'Svelte\nKit' })
  assert.equal(questionAnswer(request.questions[0], writeQuestionDraft(draft, '')), undefined)
  assert.deepEqual(selectQuestionOption(1), { selectedIndex: 1, text: '', skipped: false })
})

test('跳过传 null，切题保留草稿，最后按题目顺序收集全部答案', () => {
  const drafts = [
    selectQuestionOption(0),
    writeQuestionDraft(createQuestionDraft(), '聊天页和设置页'),
    { ...selectQuestionOption(1), skipped: true },
  ]
  assert.deepEqual(collectQuestionAnswers(request.questions, drafts), [
    { id: 'framework', value: 'React' },
    { id: 'scope', value: '聊天页和设置页' },
    { id: 'deadline', value: null },
  ])
  assert.equal(drafts[2].selectedIndex, 1)
  assert.deepEqual(questionAnswer(request.questions[2], writeQuestionDraft(drafts[2], '下周')), {
    id: 'deadline',
    value: '下周',
  })
})
