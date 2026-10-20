import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { UserInputQuestion } from '@pi-meme/contracts/user-input'
import { create } from '../src/agent/entry'

async function tool() {
  const tools: ToolDefinition[] = []
  const requests: UserInputQuestion[][] = []
  let enabled = false
  const [extension] = create({
    registerInteractionPolicy: (value) => {
      enabled = value
    },
    requestUserInput: async (questions) => {
      requests.push(questions)
      return { answers: questions.map((question) => ({ id: question.id, value: null })), cancelled: false }
    },
  })
  if (!extension || typeof extension === 'function') throw new Error('提问扩展必须包含命名工厂')
  await extension.factory({ registerTool: (value: ToolDefinition) => tools.push(value) } as unknown as ExtensionAPI)
  assert.equal(enabled, true)
  assert.deepEqual(
    tools.map((value) => value.name),
    ['request_user_input'],
  )
  return { question: tools[0]!, requests }
}

test('interaction 内置工厂注册提问工具并返回完整答案，不要求规划模式', async () => {
  const { question, requests } = await tool()
  const questions = [
    { id: 'scope', question: '范围', options: [{ label: '全部', description: '全部页面' }] },
    { id: 'detail', question: '说明' },
  ]
  const result = await question.execute('call', { questions }, undefined, undefined, { hasUI: true } as never)
  assert.deepEqual(requests, [questions])
  assert.deepEqual(result.details, {
    answers: [
      { id: 'scope', value: null },
      { id: 'detail', value: null },
    ],
    cancelled: false,
  })
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), result.details)
})

test('提问工具英文说明明确跳过语义，保留问题数量和可选字段契约', async () => {
  const { question } = await tool()
  assert.equal(question.label, '向用户提问')
  assert.match(question.description, /default and Plan modes/)
  assert.match(question.description, /null means skipped/)
  assert.match(question.description, /skipped or cancelled answer is not approval/)
  const schema = question.parameters as {
    required: string[]
    additionalProperties: boolean
    properties: {
      questions: {
        minItems: number
        maxItems: number
        description: string
        items: {
          required: string[]
          additionalProperties: boolean
          properties: {
            id: { description: string; minLength: number }
            question: { description: string; minLength: number }
            options: {
              minItems: number
              description: string
              items: {
                required: string[]
                additionalProperties: boolean
                properties: {
                  label: { description: string; minLength: number }
                  description: { description: string; minLength: number }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual(schema.required, ['questions'])
  assert.equal(schema.additionalProperties, false)
  const questions = schema.properties.questions
  assert.equal(questions.minItems, 1)
  assert.equal(questions.maxItems, 3)
  assert.deepEqual(questions.items.required, ['id', 'question'])
  assert.equal(questions.items.additionalProperties, false)
  assert.match(questions.items.properties.id.description, /unique within this request/)
  assert.equal(questions.items.properties.id.minLength, 1)
  assert.equal(questions.items.properties.question.minLength, 1)
  const options = questions.items.properties.options
  assert.equal(options.minItems, 1)
  assert.match(options.description, /Omit for free text/)
  assert.deepEqual(options.items.required, ['label'])
  assert.equal(options.items.additionalProperties, false)
  assert.match(options.items.properties.label.description, /unique within this question/)
  assert.equal(options.items.properties.label.minLength, 1)
  assert.equal(options.items.properties.description.minLength, 1)
})

test('提问工具拒绝无 UI 和重复题目或选项，不发送无效请求', async () => {
  const { question, requests } = await tool()
  const input = { questions: [{ id: 'scope', question: '范围' }] }
  await assert.rejects(question.execute('call', input, undefined, undefined, { hasUI: false } as never), /当前客户端/)
  await assert.rejects(
    question.execute('call', { questions: [...input.questions, ...input.questions] }, undefined, undefined, {
      hasUI: true,
    } as never),
    /不能重复/,
  )
  await assert.rejects(
    question.execute(
      'call',
      { questions: [{ id: 'scope', question: '范围', options: [{ label: '全部' }, { label: '全部' }] }] },
      undefined,
      undefined,
      { hasUI: true } as never,
    ),
    /选项 label 不能重复/,
  )
  assert.equal(requests.length, 0)
})
