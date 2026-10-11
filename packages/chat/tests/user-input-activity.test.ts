import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseToolMeta } from '../src/ui/model/tool-details'
import { runningActivityLabel } from '../src/ui/model/activity-summary'

test('提问工具在消息流展示待答和完成文案', () => {
  const item = { id: 'question', name: 'request_user_input', status: 'running' as const }
  assert.equal(runningActivityLabel([item]), '等待你的回答…')
  assert.equal(parseToolMeta({ ...item, status: 'success' }).summary, '已向用户提问')
})
