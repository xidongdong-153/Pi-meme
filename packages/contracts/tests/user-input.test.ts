import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateUserInputQuestions,
  validateUserInputAnswers,
  validateExtensionUIResponse,
  validateExtensionDialogResponse,
} from '../src/user-input'

const questions = [
  { id: 'scope', question: '修改范围', options: [{ label: '全部', description: '包含所有页面' }, { label: '当前页' }] },
  { id: 'detail', question: '补充说明' },
]

test('多题输入支持选项说明和自由文本，要求题目和选项有效且唯一', () => {
  assert.doesNotThrow(() => validateUserInputQuestions(questions))
  for (const invalid of [
    [],
    Array.from({ length: 4 }, (_, index) => ({ id: String(index), question: '问题' })),
    [{ id: ' ', question: '问题' }],
    [{ id: 'scope', question: ' ' }],
    [...questions, questions[0]],
    [{ id: 'scope', question: '问题', options: [] }],
    [{ id: 'scope', question: '问题', options: [{ label: ' ' }] }],
    [{ id: 'scope', question: '问题', options: [{ label: '全部', description: '' }] }],
    [{ id: 'scope', question: '问题', options: [{ label: '全部' }, { label: '全部' }] }],
    [{ id: 'scope', question: '问题', unexpected: true }],
  ])
    assert.throws(() => validateUserInputQuestions(invalid))
})

test('答案允许自由文本和 null 跳过，必须恰好包含所有题目且不重复', () => {
  const answers = [
    { id: 'scope', value: '只改桌面端' },
    { id: 'detail', value: null },
  ]
  assert.doesNotThrow(() => validateUserInputAnswers(answers, questions))
  for (const invalid of [
    [],
    [{ id: 'scope', value: '全部' }],
    [
      { id: 'scope', value: '全部' },
      { id: 'unknown', value: null },
    ],
    [
      { id: 'scope', value: '全部' },
      { id: 'scope', value: null },
    ],
    [
      { id: 'scope', value: ' ' },
      { id: 'detail', value: null },
    ],
    [
      { id: 'scope', value: false },
      { id: 'detail', value: null },
    ],
    [
      { id: 'scope', value: '全部', extra: 1 },
      { id: 'detail', value: null },
    ],
  ])
    assert.throws(() => validateUserInputAnswers(invalid, questions))
})

test('多题交互拒绝旧响应类型，取消保持单独 cancelled 字段', () => {
  const request = { type: 'extension_ui_request', id: 'request', method: 'questions', questions } as const
  assert.doesNotThrow(() => validateExtensionDialogResponse(request, { cancelled: true }))
  assert.doesNotThrow(() =>
    validateExtensionDialogResponse(request, {
      answers: [
        { id: 'scope', value: null },
        { id: 'detail', value: null },
      ],
    }),
  )
  for (const response of [
    { value: '全部' },
    { confirmed: true },
    { cancelled: false },
    { cancelled: true, answers: [] },
  ])
    assert.throws(() => validateExtensionDialogResponse(request, response))
  for (const response of [{ value: '文本' }, { confirmed: false }, { cancelled: true }])
    assert.doesNotThrow(() => validateExtensionUIResponse(response))
})
