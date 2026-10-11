import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiUserInputRequest } from '@pi-meme/contracts/user-input'
import { ExtensionDialogs } from '../src/extension-dialogs'

test('多题 dialog 拒绝重复请求 id，超时后拒绝迟到回答', async () => {
  let expired!: () => void
  const timeout = new Promise<void>((resolve) => {
    expired = resolve
  })
  const dialogs = new ExtensionDialogs((id) => {
    assert.equal(id, 'request')
    expired()
  })
  const request: PiUserInputRequest = {
    type: 'extension_ui_request',
    id: 'request',
    method: 'questions',
    questions: [{ id: 'scope', question: '范围' }],
    timeout: 10,
  }
  dialogs.add(request)
  assert.throws(() => dialogs.add(request), /id 不能重复/)
  await timeout
  assert.throws(() => dialogs.response(request.id, { answers: [{ id: 'scope', value: null }] }), /已取消或超时/)
})
