import assert from 'node:assert/strict'
import { test } from 'vitest'
import { composerHintSystemPrompt } from '../src/sdk/composer-hint'
import { requestText, startFakeProvider } from '../../../tests/fixtures/fake-provider.mjs'

async function complete(baseUrl: string, messages: Array<{ role: string; content: string }>) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', messages, stream: true }),
  })
  assert.equal(response.status, 200)
  return response.text()
}

function assistantText(stream: string) {
  let text = ''
  for (const line of stream.split('\n')) {
    if (!line.startsWith('data: ') || line.startsWith('data: [DONE]')) continue
    const payload = JSON.parse(line.slice('data: '.length)) as {
      choices?: Array<{ delta?: { content?: string } }>
    }
    text += payload.choices?.[0]?.delta?.content ?? ''
  }
  return text
}

test('输入框提示不进入用户轮次，也不占用下一次脚本工具', async () => {
  const names: string[] = []
  const provider = await startFakeProvider({
    reply(_body, index) {
      const name = index === 1 ? 'ls' : 'read'
      names.push(name)
      return { tool: { name } }
    },
  })
  try {
    await complete(provider.baseUrl, [{ role: 'user', content: '只读' }])
    const developerHint = await complete(provider.baseUrl, [
      { role: 'developer', content: composerHintSystemPrompt },
      { role: 'user', content: '用户：只读\n助手：完成' },
    ])
    const systemHint = await complete(provider.baseUrl, [
      { role: 'system', content: composerHintSystemPrompt },
      { role: 'user', content: '用户：只读\n助手：完成' },
    ])
    await complete(provider.baseUrl, [{ role: 'user', content: '继续' }])
    assert.equal(assistantText(developerHint), '{"show":false}')
    assert.equal(assistantText(systemHint), '{"show":false}')
    assert.deepEqual(names, ['ls', 'read'])
    assert.equal(provider.requests.length, 2)
    assert.equal(provider.sideRequests.length, 2)
    for (const body of provider.sideRequests) assert.equal(requestText(body).startsWith(composerHintSystemPrompt), true)
    for (const body of provider.requests) assert.equal(requestText(body).includes(composerHintSystemPrompt), false)
  } finally {
    await provider.close()
  }
})
