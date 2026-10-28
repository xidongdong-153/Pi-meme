import type { ExtensionAPI, ExtensionToolContext, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationRequest } from '@pi-meme/contracts/image-generation'
import { expect, test } from 'vitest'
import { create } from '../src/agent/entry'
import { recentImageSources } from '../src/agent/recent-images'
import { png } from './fixture'

const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') }
function entry(id: string, content: unknown, extra = {}): SessionEntry {
  return {
    id,
    parentId: null,
    type: 'message',
    message: { role: 'user', content, ...extra },
  } as unknown as SessionEntry
}

test('直接图片工具允许可选字段用 null 占位，并保持两种有效引用互斥', async () => {
  let tool: ToolDefinition | undefined
  const requests: ImageGenerationRequest[] = []
  const [extension] = create({
    taskMode: () => 'default',
    accessMode: () => 'workspace-write',
    requestImageGeneration: async (request) => {
      requests.push(request)
      return {
        image: { ...image, type: 'image' },
        artifact: {
          id: 'image',
          path: '/host/generated.png',
          mimeType: 'image/png',
          operation: 'generate',
          model: 'test',
          sources: [],
        },
      }
    },
  })
  if (typeof extension === 'function') throw new Error('预期内联扩展对象')
  await extension.factory({
    registerTool: (value: ToolDefinition) => {
      tool = value
    },
    on: () => {},
  } as unknown as ExtensionAPI)
  const ctx = { sessionManager: { getBranch: () => [entry('upload', [image])] } } as unknown as ExtensionToolContext
  await tool!.execute(
    'generate',
    { prompt: '生成', referenced_image_paths: null, num_last_images_to_include: null, transparent_background: null },
    undefined,
    undefined,
    ctx,
  )
  expect(requests.at(-1)).toMatchObject({ action: 'generate', sources: [] })
  await tool!.execute(
    'path',
    { prompt: '编辑', referenced_image_paths: ['source.png'], num_last_images_to_include: null },
    undefined,
    undefined,
    ctx,
  )
  expect(requests.at(-1)).toMatchObject({ sources: [{ path: 'source.png' }] })
  await tool!.execute(
    'recent',
    { prompt: '编辑', referenced_image_paths: null, num_last_images_to_include: 1 },
    undefined,
    undefined,
    ctx,
  )
  expect(requests.at(-1)).toMatchObject({ sources: [{ entryId: 'upload' }] })
  await expect(
    tool!.execute(
      'invalid',
      { prompt: '编辑', referenced_image_paths: ['source.png'], num_last_images_to_include: 1 },
      undefined,
      undefined,
      ctx,
    ),
  ).rejects.toThrow('不能同时')
  const schema = JSON.parse(JSON.stringify(tool!.parameters)) as { properties: Record<string, { anyOf: unknown[] }> }
  for (const key of ['referenced_image_paths', 'num_last_images_to_include', 'transparent_background']) {
    expect(schema.properties[key].anyOf).toContainEqual({ type: 'null' })
  }
})
test('最近图片使用当前分支和 entry ID，应用删除与替换，生成产物只计一次', () => {
  const a = entry('a', [image])
  const b = entry('b', [image], {
    role: 'toolResult',
    toolName: 'image_gen',
    details: { artifact: { path: '/host/generated.png' } },
  })
  const c = entry('c', [image, image])
  const edits = [
    { type: 'context_edit', id: 'edit-a', targetId: 'a', replacement: null },
    { type: 'context_edit', id: 'edit-c', targetId: 'c', replacement: { role: 'user', content: [image] } },
  ] as unknown as SessionEntry[]
  expect(recentImageSources([a, b, c, ...edits], 2)).toEqual([
    { entryId: 'b', index: 0, path: '/host/generated.png' },
    { entryId: 'c', index: 0, image },
  ])
  expect(() => recentImageSources([a], 2)).toThrow('只有 1 张')
  expect(recentImageSources([c], 1)[0]).toMatchObject({ entryId: 'c', index: 1 })
  expect(recentImageSources([a, entry('failed', [image], { role: 'toolResult', isError: true })], 1)[0].entryId).toBe(
    'a',
  )
})

test('内置工具按配置与权限更新可见性，路径和最近图片使用同一 Host 请求桥', async () => {
  let mode: 'default' | 'plan' = 'default'
  let access: 'read-only' | 'workspace-write' = 'workspace-write'
  let ready = false
  let active = ['read', 'image_gen']
  let tool: ToolDefinition | undefined
  const hooks = new Map<string, (event: { toolName: string }) => Promise<unknown>>()
  const requests: ImageGenerationRequest[] = []
  const [extension] = create({
    taskMode: () => mode,
    accessMode: () => access,
    requestImageGeneration: async (request) => {
      requests.push(request)
      return request.action === 'ready'
        ? { ready }
        : {
            image: { ...image, type: 'image' },
            artifact: {
              id: 'artifact',
              path: '/host/output.png',
              mimeType: 'image/png',
              operation: 'generate',
              model: 'image-model',
              sources: [],
            },
          }
    },
  })
  if (typeof extension === 'function') throw new Error('预期内联扩展对象')
  await extension.factory({
    registerTool: (value: ToolDefinition) => {
      tool = value
    },
    on: (name: string, handler: (event: { toolName: string }) => Promise<unknown>) => hooks.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => {
      active = next
    },
  } as unknown as ExtensionAPI)
  const before = () => hooks.get('before_agent_start')!({ toolName: '' })
  await before()
  expect(active).not.toContain('image_gen')
  ready = true
  await before()
  expect(active).toContain('image_gen')
  const ctx = { sessionManager: { getBranch: () => [entry('user-image', [image])] } } as unknown as ExtensionToolContext
  const result = await tool!.execute(
    'call',
    { prompt: '修改', num_last_images_to_include: 1 },
    undefined,
    undefined,
    ctx,
  )
  expect(result.content[1]).toMatchObject({ type: 'image' })
  expect(requests.at(-1)).toMatchObject({ action: 'generate', sources: [{ entryId: 'user-image', index: 0 }] })
  await tool!.execute('call-path', { prompt: '修改', referenced_image_paths: ['asset.png'] }, undefined, undefined, ctx)
  expect(requests.at(-1)).toMatchObject({ action: 'generate', sources: [{ path: 'asset.png' }] })
  access = 'read-only'
  await before()
  expect(active).not.toContain('image_gen')
  await expect(tool!.execute('blocked', { prompt: '图' }, undefined, undefined, ctx)).rejects.toThrow('访问权限')
  access = 'workspace-write'
  mode = 'plan'
  await before()
  expect(active).not.toContain('image_gen')
  expect(() => hooks.get('tool_call')!({ toolName: 'image_gen' })).toThrow('任务模式')
})
