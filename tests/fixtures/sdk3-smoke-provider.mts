import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { useFakeAgent } from './fake-agent.mjs'

const marker = 'tests/fixtures/sdk3-smoke-provider.mts'
const toolName = 'sdk3_smoke_read_workspace'
type ModelMessage = { role?: string; content?: unknown }
type ModelRequest = { messages?: ModelMessage[]; tools?: Array<{ function?: { name?: string } }> }
function text(message: ModelMessage | undefined) {
  if (typeof message?.content === 'string') return message.content
  return Array.isArray(message?.content)
    ? message.content.map((part: { text?: string }) => part.text ?? '').join('\n')
    : ''
}

export async function startSdk3SmokeProvider(root = path.resolve(import.meta.dirname, '../..')) {
  const dataRoot = path.join(root, 'out/sdk3-smoke/host')
  try {
    const existing = await lstat(dataRoot)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('临时 Host 数据根不是普通目录')
    if (
      (await readdir(dataRoot)).length &&
      (await readFile(path.join(dataRoot, '.sdk3-smoke-fixture'), 'utf8').catch(() => '')) !== marker
    )
      throw new Error('临时 Host 数据根已有非本 fixture 的内容，拒绝覆盖模型与测试凭据')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  await mkdir(path.join(dataRoot, 'pi'), { recursive: true })
  await writeFile(path.join(dataRoot, '.sdk3-smoke-fixture'), marker)
  const fake = await useFakeAgent(path.join(root, 'out/sdk3-smoke/provider'), {
    models: [{ id: 'first', name: 'SDK3 本地假模型', reasoning: false }],
    reply: (body: ModelRequest) => {
      const messages = body.messages ?? []
      // Plan 会在输入后追加 user 上下文，按显式工具标记和其后的工具结果配对。
      const requestIndex = messages.findLastIndex(
        (message) => message.role === 'user' && text(message).includes(toolName),
      )
      const resultIndex = messages.findLastIndex((message) => message.role === 'tool')
      if (resultIndex > requestIndex && resultIndex >= 0)
        return {
          text: `本地假模型已收到真实工具返回；以下仅是验收报告，不是模型推理结果。\n${text(messages[resultIndex]).slice(0, 10000)}`,
        }
      const requested = text(messages[requestIndex])
      if (requested.includes(toolName)) {
        if (!(body.tools ?? []).some((tool) => tool.function?.name === toolName))
          return { text: '本地假模型没有收到 SDK3 演示工具。请显式选择插件、授予受限 workspace.read，并检查有效权限。' }
        return {
          tool: {
            id: `sdk3_smoke_${randomUUID()}`,
            name: toolName,
            arguments: JSON.stringify({ includeShared: /includeShared\s*=\s*true/u.test(requested) }),
          },
        }
      }
      return {
        text: 'SDK3 本地假模型回复。可先测试普通 user/assistant 消息动作，再通过插件按钮插入只读工具模板。此服务不会连接真实模型。',
      }
    },
  })
  try {
    await copyFile(fake.modelsFile, path.join(dataRoot, 'pi/models.json'))
    await writeFile(
      path.join(dataRoot, 'test-credentials.json'),
      `${JSON.stringify(Object.fromEntries(fake.credentials.entries()), null, 2)}\n`,
    )
  } catch (cause) {
    await fake.dispose()
    throw cause
  }
  return {
    dataRoot,
    model: { provider: 'fake', id: 'first' },
    providerUrl: fake.provider.baseUrl,
    dispose: fake.dispose,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startSdk3SmokeProvider()
    .then((fixture) => {
      console.log(
        JSON.stringify(
          {
            message: '本地假 provider 已准备；尚未启动 Host 或 Web。浏览器中显式选择 fake/first。',
            dataRoot: fixture.dataRoot,
            model: fixture.model,
            providerUrl: fixture.providerUrl,
            server:
              'PI_MEME_DATA_ROOT="$PWD/out/sdk3-smoke/host" PI_MEME_TEST_CREDENTIALS=memory PI_MEME_TOKEN=sdk3-smoke-local-only PI_MEME_PORT=40213 pnpm run start:server',
            web: 'PI_MEME_HOST_URL=http://127.0.0.1:40213 pnpm run start:web',
          },
          null,
          2,
        ),
      )
      let stopping = false
      const stop = () => {
        if (stopping) return
        stopping = true
        void fixture.dispose().catch((cause: unknown) => {
          console.error(cause instanceof Error ? cause.message : String(cause))
          process.exitCode = 1
        })
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : String(cause))
      process.exitCode = 1
    })
}
