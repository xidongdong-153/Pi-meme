import type { Snapshot } from '@pi-meme/contracts/desktop'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { createHost } from '../src/service'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'

test('内置图片配置通过 HostApi 与控制接口保存，不依赖聊天选择且不把凭据写入控制日志', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-image-control-'))
  const credentials = new MemoryCredentialStorage()
  let host = await createHost({ dataRoot: root, credentials })
  try {
    expect((await host.app.capabilities()).features).toContain('image-generation')
    const initial = await host.app.imageGeneration!.getConfig()
    const response = await host.control.dispatch({
      apiVersion: 2,
      clientId: 'image-settings',
      method: 'imageGeneration.saveModel',
      args: [
        {
          revision: initial.revision,
          model: {
            id: 'image',
            name: '图片',
            baseUrl: 'https://example.com/v1',
            model: 'image-model',
            size: 'auto',
            quality: 'auto',
          },
          apiKey: 'host-image-secret',
        },
      ],
    })
    expect(response.error).toBeUndefined()
    expect((await host.app.imageGeneration!.getConfig()).defaultId).toBe('image')
    for (const file of [
      'config/agent/image-generation.json',
      'state/control/snapshot.json',
      'state/control/events.jsonl',
      'state/control/operations.jsonl',
    ]) {
      const content = await readFile(path.join(root, file), 'utf8').catch(() => '')
      expect(content).not.toContain('host-image-secret')
    }
    await host.dispose()
    host = await createHost({ dataRoot: root, credentials })
    expect((await host.app.imageGeneration!.getConfig()).models[0].hasApiKey).toBe(true)
  } finally {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('真实会话 Worker 生图后引用当前分支产物继续编辑，结果可经 Host 文件接口预览', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-image-session-')))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
    'base64',
  )
  const requests: string[] = []
  let step = 0
  const fake = await useFakeAgent(root, {
    reply: (body) => {
      expect(JSON.stringify(body.tools)).toContain('image_gen')
      step++
      if (step === 1) return { tool: { name: 'image_gen', arguments: JSON.stringify({ prompt: '生成蓝色图形' }) } }
      if (step === 2)
        return {
          tool: { name: 'image_gen', arguments: JSON.stringify({ prompt: '改为红色', num_last_images_to_include: 1 }) },
        }
      return { text: '图片已生成并编辑。' }
    },
  })
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 读取完整请求后返回固定测试图片。 */
    }
    requests.push(request.url!)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let host = await createHost({ dataRoot: fake.dataRoot, credentials: fake.credentials })
  try {
    const config = await host.app.imageGeneration!.getConfig()
    await host.app.imageGeneration!.saveModel({
      revision: config.revision,
      model: {
        id: 'fixture',
        name: '测试图片',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'image',
        size: 'auto',
        quality: 'auto',
      },
      apiKey: 'fake-image-key',
    })
    const session = await host.app.sessions.create(
      { configuration: { accessMode: 'full-access', model: { provider: 'fake', id: 'first' } } },
      { idempotencyKey: 'image-session' },
    )
    const receipt = await host.app.sessions.submit(
      session,
      { delivery: 'start', text: '生成图片，然后把它改成红色。' },
      { idempotencyKey: 'image-submit' },
    )
    await vi.waitFor(
      async () => expect((await host.app.sessions.receipt(receipt.operationId)).status).toBe('completed'),
      { timeout: 10000 },
    )
    expect(requests).toEqual(['/v1/images/generations', '/v1/images/edits'])
    const snapshot = await host.app.sessions.snapshot(session)
    const results = snapshot.messages.filter(
      (message) => message.role === 'toolResult' && message.toolName === 'image_gen',
    )
    expect(results).toHaveLength(2)
    const library = await host.app.imageLibrary!.list()
    expect(library.items).toHaveLength(2)
    expect(library.items.every((item) => item.session.sessionId === session.sessionId)).toBe(true)
    expect(library.items.map((item) => item.operation).sort()).toEqual(['edit', 'generate'])
    const image = library.items[0]
    const renamed = await host.control.dispatch({
      apiVersion: 2,
      clientId: 'image-library-test',
      method: 'imageLibrary.rename',
      args: [image.id, '作品名称'],
      idempotencyKey: 'rename-image',
    })
    expect(renamed.error).toBeUndefined()
    expect((await host.app.imageLibrary!.list({ query: '作品名称' })).items).toHaveLength(1)
    expect((await host.app.imageLibrary!.read(image.id)).dataUrl).toContain(png.toString('base64'))
    await host.app.imageLibrary!.remove(image.id, { idempotencyKey: 'remove-image' })
    expect((await host.app.imageLibrary!.list()).items).toHaveLength(1)

    for (const message of results) {
      if (message.role !== 'toolResult') continue
      expect(message.isError).toBe(false)
      expect(message.content.some((part) => part.type === 'image')).toBe(true)
      const artifact = (message.details as { artifact: { path: string } }).artifact
      expect((await host.app.files.preview(session, artifact.path)).kind).toBe('image')
      expect(await readFile(artifact.path)).toEqual(png)
    }
    await host.app.imageGeneration!.test('fixture')
    expect((await host.app.imageLibrary!.list()).items).toHaveLength(1)
    const rpc = async (method: string, args: unknown[] = [], sessionId?: string) => {
      const response = await host.rpc({
        requestId: crypto.randomUUID(),
        clientId: 'image-temporary',
        method,
        args,
        sessionId,
      })
      expect(response.error).toBeUndefined()
      return response.result as Snapshot
    }
    const main = await rpc('pi:snapshot')
    const temporary = await rpc('temporary-session:open', [{ sourceSessionKey: main.connection.sessionKey }])
    const temporaryKey = temporary.connection.sessionKey!
    step = 0
    await rpc('pi:access-mode', [temporaryKey, 'full-access'], temporaryKey)
    await rpc('pi:prompt', [temporaryKey, '生成临时图片', [], [], { mode: 'default' }], temporaryKey)
    let temporaryImages: string[] = []
    await vi.waitFor(
      async () => {
        const current = await rpc('pi:snapshot', [], temporaryKey)
        temporaryImages = current.messages.flatMap((message) =>
          message.role === 'toolResult' && message.toolName === 'image_gen' && !message.isError
            ? [(message.details as { artifact: { id: string } }).artifact.id]
            : [],
        )
        expect(temporaryImages).toHaveLength(2)
        expect(current.state.isStreaming).toBe(false)
      },
      { timeout: 10000 },
    )
    expect((await host.app.imageLibrary!.list()).items).toHaveLength(1)
    const index = await readFile(
      path.join(fake.dataRoot, 'state/modules/%40pi-meme%2Fimage-generation/library.json'),
      'utf8',
    )
    for (const id of temporaryImages) expect(index).not.toContain(id)
    await rpc('temporary-session:close', [temporaryKey], temporaryKey)

    await host.dispose()
    await rm(path.join(fake.dataRoot, 'state/modules/%40pi-meme%2Fimage-generation/library.json'))
    host = await createHost({ dataRoot: fake.dataRoot, credentials: fake.credentials })
    await host.app.imageLibrary!.list()
    await vi.waitFor(async () => expect((await host.app.imageLibrary!.list()).items).toHaveLength(2))
    const imported = (await host.app.imageLibrary!.list()).items
    expect(imported.map((item) => item.prompt).sort()).toEqual(['改为红色', '生成蓝色图形'].sort())
    const source = await host.app.sessions.get(session)
    await rm(source.sessionFile!)
    expect((await host.app.imageLibrary!.read(imported[0].id)).dataUrl).toContain(png.toString('base64'))
  } finally {
    await host.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
