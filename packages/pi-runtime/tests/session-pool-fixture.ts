import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionFactory } from '../src/session-pool'
import { readdirSync } from 'node:fs'
import { SdkSession } from '../src/sdk/session'
import { userMessage } from '../../../tests/fixtures/messages.mjs'
import type { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { requestText } from '../../../tests/fixtures/fake-provider.mjs'

function createTestSession(...[cwd, notify, paths, credentials, mcp]: Parameters<SessionFactory>) {
  const session = new SdkSession(cwd, notify, paths, credentials, mcp)
  const configure = session.configureInlineExtensions.bind(session)
  let builtins: Parameters<typeof configure>[0] = []
  const refresh = () => {
    const directory = path.join(cwd, 'test-native-agents')
    let files: string[] = []
    try {
      files = readdirSync(directory)
    } catch {}
    configure([
      ...builtins,
      ...files.map((name) => ({
        name: `test-native:${path.join(directory, name)}`,
        factory: async (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
          const module = (await import(pathToFileURL(path.join(directory, name)).href)) as {
            default: import('@earendil-works/pi-coding-agent').ExtensionFactory
          }
          await module.default(pi)
        },
      })),
    ])
  }
  session.configureInlineExtensions = (extensions) => {
    builtins = extensions
    refresh()
  }
  refresh()
  const stop = session.stopAndWait.bind(session)
  session.stopAndWait = async () => {
    await stop()
    refresh()
  }
  return session
}

const extension = fileURLToPath(new URL('../../../tests/fixtures/test-extension.mjs', import.meta.url))

async function installProjectExtension(directory: string, source = extension) {
  const extensionsDirectory = path.join(directory, 'test-native-agents')
  await mkdir(extensionsDirectory, { recursive: true })
  const installed = path.join(extensionsDirectory, `${path.basename(source, path.extname(source))}.js`)
  await copyFile(source, installed)
  return installed
}

async function installBrokenProjectExtension(directory: string) {
  const extensionsDirectory = path.join(directory, 'test-native-agents')
  await mkdir(extensionsDirectory, { recursive: true })
  const installed = path.join(extensionsDirectory, 'broken-extension.js')
  await writeFile(installed, "throw new Error('模拟扩展加载失败')\n")
  return installed
}

async function appSessionFile(agent: Awaited<ReturnType<typeof useFakeAgent>>, cwd: string, filename: string) {
  const directory = agent.runtimePaths.sessionDirectory(cwd)
  await mkdir(directory, { recursive: true })
  return path.join(directory, filename)
}

function slowReply(body: { messages?: unknown[] }) {
  return { text: '收到', delayMs: requestText(body).includes('slow') ? 1000 : 0 }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待会话状态超时')
    await delay(10)
  }
}

function dialogue(messages: readonly { role: string }[]) {
  return messages.filter((message) => message.role !== 'system')
}

function conversation(messages: readonly { role: string; content?: unknown }[]) {
  return messages.map((message) => ({ role: message.role, text: messageText(message) }))
}

function messageText(message: { role: string; content?: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' && part !== null && part.type === 'text',
    )
    .map((part) => part.text)
    .join('')
}

async function savedSession(agent: Awaited<ReturnType<typeof useFakeAgent>>, directory: string, name: string) {
  const file = await appSessionFile(agent, directory, `${name}.jsonl`)
  await writeFile(
    file,
    [
      { type: 'session', id: name, version: 3, cwd: directory, timestamp: '2026-09-29T00:00:00Z' },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp: '2026-09-29T00:00:00Z',
        provider: 'fake',
        modelId: 'first',
      },
      {
        type: 'message',
        id: 'user',
        parentId: 'model',
        timestamp: '2026-09-29T00:00:01Z',
        message: userMessage(name, 1),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  return file
}

export {
  appSessionFile,
  conversation,
  createTestSession,
  dialogue,
  extension,
  installBrokenProjectExtension,
  installProjectExtension,
  messageText,
  savedSession,
  slowReply,
  waitFor,
}
