import { expect, test, vi, afterEach } from 'vitest'
import { createLinkPreviewLoader, parseLinkPreview } from '../src/link-preview'
import { PluginHttpBroker } from '../src/plugin-http-broker'

afterEach(() => vi.restoreAllMocks())

test('提取 Open Graph、摘要与相对图片，不把 HTML 当成可执行内容', () => {
  expect(
    parseLinkPreview(
      `<head><title>后备标题</title>
    <meta content="标题 &amp; 内容" property="og:title">
    <meta name='description' content='摘要 &#x4e2d;&#25991;'>
    <meta property="og:image" content="/cover.png">
    <link rel="shortcut icon" href="/favicon.ico">
    <script>const x = '<meta property="og:title" content="错误">'</script>
    </head>`,
      'https://example.com/docs',
    ),
  ).toEqual({
    url: 'https://example.com/docs',
    title: '标题 & 内容',
    description: '摘要 中文',
    image: 'https://example.com/cover.png',
    icon: 'https://example.com/favicon.ico',
  })
  expect(
    parseLinkPreview(
      '<title>A &amp; B</title><meta property="og:image" content="javascript:alert(1)">',
      'https://example.com',
    ).image,
  ).toBeUndefined()
})

test('按 URL 缓存并发预览，使用无凭据的受限 GET 请求', async () => {
  const request = vi
    .spyOn(PluginHttpBroker.prototype, 'request')
    .mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, body: '<title>文档</title>' })
  const load = createLinkPreviewLoader()
  const [first, second] = await Promise.all([
    load('https://example.com/docs#one'),
    load('https://example.com/docs#two'),
  ])
  expect(first).toEqual(second)
  expect(first.title).toBe('文档')
  expect(request).toHaveBeenCalledOnce()
  expect(request.mock.calls[0][3]).toMatchObject({ method: 'GET', url: 'https://example.com/docs' })
  expect(request.mock.calls[0][3]).not.toHaveProperty('credentialRef')
})

test('不接受非 HTTPS、内嵌凭据与非网页响应', async () => {
  const load = createLinkPreviewLoader()
  expect(() => load('file:///etc/passwd')).toThrow('公开 HTTPS')
  expect(() => load('http://localhost/')).toThrow('公开 HTTPS')
  expect(() => load('https://user:secret@example.com')).toThrow('公开 HTTPS')
  vi.spyOn(PluginHttpBroker.prototype, 'request').mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  await expect(load('https://example.com')).rejects.toThrow('可用的预览')
})
