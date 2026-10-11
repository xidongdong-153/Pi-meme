import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiUserInputRequest } from '@pi-meme/contracts/user-input'
import { UserInputPanel } from '../src/ui/user-input-panel'
import {
  collectQuestionAnswers,
  createQuestionDraft,
  questionAnswer,
  selectQuestionOption,
  writeQuestionDraft,
  type UserInputDraft,
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

function markup(draft?: UserInputDraft) {
  return renderToStaticMarkup(createElement(UserInputPanel, { request, draft, onRespond: async () => {} }))
}

test('卡片初始无默认答案，未答不能下一步，显示题数、完整选项和可访问标签', () => {
  const html = markup()
  assert.match(html, /role="region" aria-label="Agent 提问"/)
  assert.match(html, /role="radiogroup"/)
  assert.equal((html.match(/aria-checked="false"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /aria-checked="true"/)
  assert.match(html, /aria-label="第 1 题，共 3 题"/)
  assert.match(html, /沿用现有界面/)
  assert.match(html, /aria-label="下一题" disabled/)
  assert.match(html, /disabled=""[^>]*>下一步/)
  assert.match(html, /placeholder="或自行撰写回复"/)
  assert.doesNotMatch(html, /麦克风|microphone/)
})

test('恢复切会话草稿时显示当前题和自填答案，最后一题显示发送', () => {
  const drafts = request.questions.map(createQuestionDraft)
  drafts[2] = writeQuestionDraft(selectQuestionOption(0), '明天')
  const html = markup({ currentIndex: 2, drafts })
  assert.match(html, /何时完成？/)
  assert.match(html, /aria-label="第 3 题，共 3 题"/)
  assert.match(html, />明天<\/textarea>/)
  assert.doesNotMatch(html, /aria-checked="true"/)
  assert.match(html, />发送</)
  assert.doesNotMatch(html, />下一步</)
})

test('单题隐藏导航和题数，保留单行自填、跳过和发送', () => {
  const html = renderToStaticMarkup(
    createElement(UserInputPanel, {
      request: { ...request, questions: [request.questions[0]] },
      onRespond: async () => {},
    }),
  )
  assert.doesNotMatch(html, /aria-label="上一题"|aria-label="下一题"|第 1 题，共 1 题/)
  assert.match(html, /aria-label="关闭问题"/)
  assert.match(html, /rows="1"/)
  assert.match(html, /aria-label="自行撰写回复"/)
  assert.match(html, />跳过</)
  assert.match(html, />发送</)
})
