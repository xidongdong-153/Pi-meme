import { createServer } from 'node:http'
import { open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { ImageGenerationService } from '../src/server/service'
import { downloadImage } from '../src/server/download'
import { imageFixture, png } from './fixture'

test('生图 JSON、编辑 multipart、透明背景及 URL 结果只执行一次', async () => {
  const fixture = await imageFixture()
  const requests: Array<{ url: string; auth?: string; body: Buffer; type?: string }> = []
  let baseUrl = ''
  let responseKind: 'base64' | 'url' | 'error' = 'base64'
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      url: request.url!,
      auth: request.headers.authorization,
      body: Buffer.concat(chunks),
      type: request.headers['content-type'],
    })
    if (request.url === '/output.png') {
      response.end(png)
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (responseKind === 'error') {
      response.statusCode = 401
      response.end(JSON.stringify({ error: { message: 'image-test-secret' } }))
    } else
      response.end(
        JSON.stringify({
          data: [responseKind === 'url' ? { url: `${baseUrl}/output.png` } : { b64_json: png.toString('base64') }],
        }),
      )
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  const saved: Buffer[] = []
  const service = new ImageGenerationService(fixture.store, async (_name, bytes) => {
    saved.push(bytes)
    return { path: '/host/attachments/result.png' }
  })
  const execution = { cwd: fixture.root, signal: new AbortController().signal }
  try {
    await fixture.save(`${baseUrl}/v1`)
    const generated = await service.generate(
      {
        prompt: '生成测试图',
        referenced_image_paths: null,
        num_last_images_to_include: null,
        transparent_background: null,
      },
      [],
      execution,
    )
    expect(generated.artifact.operation).toBe('generate')
    expect(generated.image.data).toBe(png.toString('base64'))
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/images/generations')
    expect(JSON.parse(requests[0].body.toString())).toMatchObject({
      model: 'image-model',
      n: 1,
      background: 'opaque',
      output_format: 'png',
    })
    await writeFile(path.join(fixture.root, 'source.png'), png)
    await service.generate(
      { prompt: '透明背景', referenced_image_paths: ['source.png'], transparent_background: true },
      [{ path: 'source.png' }],
      execution,
    )
    const form = await new Response(new Uint8Array(requests[1].body), {
      headers: { 'Content-Type': requests[1].type! },
    }).formData()
    expect(requests[1].url).toBe('/v1/images/edits')
    expect(form.get('background')).toBe('transparent')
    expect(Buffer.from(await (form.get('image[]') as File).arrayBuffer())).toEqual(png)
    await service.generate(
      { prompt: '保留背景', num_last_images_to_include: 1, referenced_image_paths: null, transparent_background: null },
      [{ image: generated.image, entryId: 'entry' }],
      execution,
    )
    const edit = await new Response(new Uint8Array(requests[2].body), {
      headers: { 'Content-Type': requests[2].type! },
    }).formData()
    expect(edit.get('background')).toBe('auto')
    responseKind = 'url'
    await service.generate({ prompt: '生成 URL 图片' }, [], execution)
    expect(requests.at(-1)?.auth).toBeUndefined()
    expect(saved).toHaveLength(4)
    responseKind = 'error'
    const before = requests.length
    await expect(service.generate({ prompt: '失败' }, [], execution)).rejects.toThrow('API Key 无效')
    expect(requests).toHaveLength(before + 1)
    expect(saved).toHaveLength(4)
    await expect(
      downloadImage('http://127.0.0.1/private.png', 'https://example.com', execution.signal),
    ).rejects.toThrow('不允许访问')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fixture.dispose()
  }
})

test('参数、文件、超限与已取消请求在联网之前拒绝，过期执行不保存结果', async () => {
  const fixture = await imageFixture()
  let saved = 0
  const service = new ImageGenerationService(fixture.store, async () => {
    saved++
    return { path: 'result' }
  })
  try {
    await fixture.save()
    const execution = { cwd: fixture.root, signal: new AbortController().signal }
    await expect(
      service.generate({ prompt: '图', referenced_image_paths: ['a'], num_last_images_to_include: 1 }, [], execution),
    ).rejects.toThrow('不能同时')
    await expect(
      service.generate({ prompt: '图', referenced_image_paths: ['missing.png'] }, [{ path: 'missing.png' }], execution),
    ).rejects.toThrow('不存在')
    await writeFile(path.join(fixture.root, 'invalid.png'), 'not an image')
    await expect(
      service.generate({ prompt: '图', referenced_image_paths: ['invalid.png'] }, [{ path: 'invalid.png' }], execution),
    ).rejects.toThrow('格式无效')
    const oversized = await open(path.join(fixture.root, 'large.png'), 'w')
    await oversized.truncate(50 * 1024 * 1024 + 1)
    await oversized.close()
    await expect(
      service.generate({ prompt: '图', referenced_image_paths: ['large.png'] }, [{ path: 'large.png' }], execution),
    ).rejects.toThrow('50 MiB')
    const controller = new AbortController()
    controller.abort()
    await expect(service.generate({ prompt: '图' }, [], { ...execution, signal: controller.signal })).rejects.toThrow(
      '已取消',
    )
    await expect(
      service.generate({ prompt: '图' }, [], {
        ...execution,
        assertActive: () => {
          throw new Error('过期执行')
        },
      }),
    ).rejects.toThrow('过期执行')
    expect(saved).toBe(0)
  } finally {
    await fixture.dispose()
  }
})

test('取消正在等待的图片请求不保存产物，也不重试', async () => {
  const fixture = await imageFixture()
  let acknowledge: () => void = () => {}
  const received = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  let requests = 0
  const server = createServer(async (request) => {
    for await (const _chunk of request) {
      /* 等待请求完整到达。 */
    }
    requests++
    acknowledge()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let saved = false
  const service = new ImageGenerationService(fixture.store, async () => {
    saved = true
    return { path: 'unexpected' }
  })
  const controller = new AbortController()
  try {
    await fixture.save(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)
    const pending = service.generate({ prompt: '等待取消' }, [], { cwd: fixture.root, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('已取消')
    await received
    controller.abort()
    await rejected
    expect(requests).toBe(1)
    expect(saved).toBe(false)
  } finally {
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fixture.dispose()
  }
})
