import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PiSessionPool } from '@pi-meme/pi-runtime/session-pool'
import { SdkSession } from '@pi-meme/pi-runtime/sdk/session'
import { fromSnapshot, applyEvent } from '@pi-meme/chat/ui/model/state'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

const extensionUrl = new URL('../../../tests/fixtures/smoke-extension.mjs', import.meta.url).href

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待会话状态超时')
    await delay(10)
  }
}

/** 消息正文可能是字符串或分片数组，断言文本时统一取文本。 */
function text(message: { role: string; content?: unknown }) {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part) => (typeof part === 'object' && part !== null && part.type === 'text' ? part.text : ''))
    .join('')
}

test('切回后台流式会话时，快照恢复已生成的正文和未结束的工具', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-session-background-'))
  const agent = await useFakeAgent(directory, {
    reply: (body) =>
      requestText(body).includes('background-stream')
        ? { text: '后台流式正文', tool: { name: 'slow-tool', arguments: JSON.stringify({ seconds: 5 }) } }
        : '收到',
  })
  const events: DesktopEvent[] = []
  const pool = new PiSessionPool(
    directory,
    {
      connection: () => {},
      event: (value) => events.push(value),
      error: () => {},
      sessionsChanged: () => {},
    },
    undefined,
    agent.runtimePaths,
    agent.credentials,
    (cwd, notify, paths, credentials, mcp) => {
      const session = new SdkSession(cwd, notify, paths, credentials, mcp)
      const configure = session.configureInlineExtensions.bind(session)
      session.configureInlineExtensions = (extensions) =>
        configure([
          ...extensions,
          {
            name: 'test-native:smoke',
            factory: async (pi) => {
              const module = (await import(extensionUrl)) as {
                default: import('@earendil-works/pi-coding-agent').ExtensionFactory
              }
              await module.default(pi)
            },
          },
        ])
      session.configureInlineExtensions([])
      return session
    },
  )
  try {
    pool.prepare(directory)
    const key = pool.connection().sessionKey!
    await pool.setAccessMode(key, 'full-access')
    await pool.prompt(key, 'background-stream')
    const firstPath = pool.getActiveSession().sessionFile!
    await waitFor(() => events.some((record) => record.event.type === 'tool_execution_start'))
    await pool.newSession()
    await pool.snapshot()
    await pool.switchSession(firstPath)
    const snapshot = await pool.snapshot()
    let chat = fromSnapshot(snapshot)
    for (const event of snapshot.events ?? []) {
      if (
        event.event.type !== 'extension_ui_request' &&
        event.event.type !== 'extension_ui_timeout' &&
        event.event.type !== 'extension_ui_closed'
      )
        chat = applyEvent(chat, event.event)
    }
    assert.equal(chat.running, true)
    assert.ok(chat.messages.some((message) => message.role === 'assistant' && text(message).includes('后台流式正文')))
    assert.ok(Object.values(chat.tools).some((tool) => tool.name === 'slow-tool' && tool.status === 'running'))
    await pool.abort(pool.connection().sessionKey!)
    assert.equal((await pool.snapshot()).state.isStreaming, false)
  } finally {
    pool.stop()
    await delay(100)
    await agent.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
