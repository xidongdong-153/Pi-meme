import assert from 'node:assert/strict'
import { test } from 'vitest'
import { collectSources } from '../src/panels/sources-data'
import { attachmentReferencesHeading } from '@pi-meme/contracts/chat-attachments'

test('空输入返回空数组', () => {
  const result = collectSources({})
  assert.deepEqual(result, [])
})

test('按优先级去重相同路径的附件，保留首次出现顺序', () => {
  const result = collectSources({
    draft: [
      { id: 'd1', type: 'file', name: 'shared.png', path: '/path/shared.png' },
      { id: 'd2', type: 'file', name: 'draft-only.txt', path: '/path/draft-only.txt' },
    ],
    sending: [{ id: 's1', type: 'file', name: 'shared.png', path: '/path/shared.png' }],
    branchAttachments: [{ id: 'b1', name: 'shared.png', path: '/path/shared.png' }],
  })

  // shared.png 既在已发又在待发/发送中，应合并为 1 项，状态优先为 sent（已附加到对话）
  assert.equal(result.length, 2)
  const shared = result.find((item) => item.path === '/path/shared.png')
  assert.ok(shared)
  assert.equal(shared.status, 'sent')
  assert.equal(shared.statusText, '已附加到对话')

  const draftOnly = result.find((item) => item.path === '/path/draft-only.txt')
  assert.ok(draftOnly)
  assert.equal(draftOnly.status, 'draft')
  assert.equal(draftOnly.statusText, '待发送')
})

test('排队消息与发送中附件正确解析并聚合', () => {
  const queuedText = `排队内容\n\n${attachmentReferencesHeading}\n- "queued.pdf"："/path/queued.pdf"`
  const result = collectSources({
    steering: [{ id: 'q1', text: queuedText, mode: 'default' }],
    sending: [{ id: 'send1', type: 'file', name: 'sending.png', path: '/path/sending.png' }],
  })

  assert.equal(result.length, 2)
  const queued = result.find((item) => item.path === '/path/queued.pdf')
  assert.ok(queued)
  assert.equal(queued.status, 'queued')
  assert.equal(queued.statusText, '排队中')

  const sending = result.find((item) => item.path === '/path/sending.png')
  assert.ok(sending)
  assert.equal(sending.status, 'sending')
  assert.equal(sending.statusText, '发送中')
})
