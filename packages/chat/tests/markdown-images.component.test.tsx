import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FilePreview } from '@pi-meme/contracts/app-host'
import { MarkdownContent } from '../src/ui/content/markdown-content'
import { MessageImageLoaderContext } from '../src/ui/content/message-image'
import { Conversation } from '../src/ui/conversation/conversation'
import { emptyChat } from '../src/ui/model/state'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { assistantMessage, userMessage } from '../../../tests/fixtures/messages.mjs'
import { ChatMessage } from '../src/ui/conversation/chat-message'
import {
  annotationAttachment,
  messageWithAttachments,
  type ComposerAttachment,
} from '../src/ui/composer/image-attachment'
import { ComposerAttachments } from '../src/ui/composer/composer-attachments'

const dataUrl = 'data:image/png;base64,YWJj'
function preview(data = dataUrl): FilePreview {
  return { kind: 'image', relativePath: 'out/sidebar.png', dataUrl: data, size: 3 }
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test.each(['string', 'blocks'])('用户附件从正文分离，图片使用 Host 预览，文件不可点击：%s', async (format) => {
  const loadImage = vi.fn(async () => preview())
  const path = '/host/attachments/upload-test/file-截图 #1%.png'
  const { message } = messageWithAttachments('只保留用户输入的文字', [
    { id: 'image', type: 'file', name: '截图 #1%.png', path },
    { id: 'file', type: 'file', name: 'report.pdf', path: '/host/attachments/upload-doc/file-report.pdf' },
  ])
  const { container } = render(
    <TooltipProvider>
      <MessageImageLoaderContext value={loadImage}>
        <ChatMessage
          message={userMessage(format === 'string' ? message : [{ type: 'text', text: message }])}
          tools={{}}
        />
      </MessageImageLoaderContext>
    </TooltipProvider>,
  )
  const body = container.querySelector('[data-message-body]')!
  expect(body.textContent).toBe('只保留用户输入的文字')
  expect(body).not.toHaveTextContent('附加文件')
  expect(body).not.toHaveTextContent('/host/attachments')
  const image = await screen.findByRole('img', { name: '截图 #1%.png' })
  expect(image).toHaveAttribute('src', dataUrl)
  expect(image.closest('[data-message-body]')).toBeNull()
  expect(loadImage).toHaveBeenCalledExactlyOnceWith(path)
  expect(body).not.toHaveTextContent('截图 #1%.png')
  expect(screen.queryByRole('button', { name: /移除|关闭|取消/ })).not.toBeInTheDocument()
  const file = screen.getByText('report.pdf')
  expect(file.closest('button, a, [role="button"]')).toBeNull()
  fireEvent.click(file)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('用户消息显示批注截图和数量，悬浮可查看评论并保留图片预览', async () => {
  const annotation = {
    id: 'first',
    tabId: 'tab',
    documentId: 1,
    url: 'https://example.com/',
    title: '示例网页',
    capturedAt: '2026-10-25T00:00:00Z',
    kind: 'element' as const,
    text: '内容',
    tag: 'img',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    viewport: { width: 100, height: 100, scale: 1, scrollX: 0, scrollY: 0 },
    comment: '看看这个',
    image: { type: 'image' as const, mimeType: 'image/png', data: 'YWJj' },
  }
  const { message, images } = messageWithAttachments('帮我看看', [
    { type: 'image', id: 'ordinary', mimeType: 'image/png', data: 'b3RoZXI=' },
    annotationAttachment(annotation),
    annotationAttachment({ ...annotation, id: 'second', tag: 'div', comment: '再看看这个', image: undefined }),
  ])
  const user = userEvent.setup()
  const { container } = render(
    <TooltipProvider>
      <ChatMessage message={userMessage([{ type: 'text', text: message }, ...images])} tools={{}} />
    </TooltipProvider>,
  )

  expect(container.querySelector('[data-message-body]')).toHaveTextContent('帮我看看')
  expect(container).not.toHaveTextContent('pi-meme.browser-annotations')
  expect(screen.getAllByRole('img', { name: '用户附件图片' })).toHaveLength(2)
  expect(screen.queryByText('看看这个')).not.toBeInTheDocument()
  const summary = screen.getByRole('button', { name: '查看 2 条批注' })
  await user.hover(summary)
  expect(await screen.findByText('看看这个')).toBeVisible()
  expect(screen.getByText('再看看这个')).toBeVisible()
  expect(screen.getByText('img')).toBeVisible()
  expect(screen.getByText('div')).toBeVisible()
  await user.unhover(summary)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '批注详情' })).not.toBeInTheDocument())
  act(() => summary.focus())
  await user.keyboard('{Enter}')
  expect(screen.getByRole('dialog', { name: '批注详情' })).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '批注详情' })).not.toBeInTheDocument())
  expect(summary).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '预览第 2 张图片' }))
  expect(screen.getByRole('img', { name: '图片大图预览，第 2 张' })).toHaveAttribute('src', dataUrl)
})

test('编辑已上传 Host 图片恢复缩略图和点击预览，附件仍仅保存路径并可移除', async () => {
  const user = userEvent.setup()
  const loadImage = vi.fn(async () => preview())
  const onRemoveImage = vi.fn()
  const attachment: ComposerAttachment = {
    id: 'host-image',
    type: 'file',
    name: '截图 #1%.png',
    path: '/host/attachments/upload-test/file-截图 #1%.png',
  }
  const original = structuredClone(attachment)
  render(
    <MessageImageLoaderContext value={loadImage}>
      <ComposerAttachments attachments={[attachment]} onRemoveImage={onRemoveImage} />
    </MessageImageLoaderContext>,
  )
  expect(await screen.findByRole('img', { name: attachment.name })).toHaveAttribute('src', dataUrl)
  expect(loadImage).toHaveBeenCalledExactlyOnceWith(attachment.path)
  await user.click(screen.getByRole('button', { name: `预览图片：${attachment.name}` }))
  expect(screen.getByRole('img', { name: '图片大图预览，第 1 张' })).toHaveAttribute('src', dataUrl)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: `移除图片：${attachment.name}` }))
  expect(onRemoveImage).toHaveBeenCalledExactlyOnceWith(attachment.id)
  expect(attachment).toEqual(original)
  expect(messageWithAttachments('正文', [attachment]).images).toEqual([])
})

test('编辑 Host 图片读取失败仍保留文件卡片和路径引用，允许移除', async () => {
  const loadImage = vi.fn().mockRejectedValue(new Error('ENOENT'))
  const onRemoveImage = vi.fn()
  const attachment: ComposerAttachment = {
    id: 'missing',
    type: 'file',
    name: 'missing.png',
    path: '/host/attachments/missing.png',
  }
  render(
    <MessageImageLoaderContext value={loadImage}>
      <ComposerAttachments attachments={[attachment]} onRemoveImage={onRemoveImage} />
    </MessageImageLoaderContext>,
  )
  expect(
    await screen.findByRole('status', { name: '图片不存在或无法读取，请确认路径相对于当前会话工作目录。' }),
  ).toBeInTheDocument()
  expect(screen.getByText('missing.png')).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  const sent = messageWithAttachments('继续发送', [attachment])
  expect(sent.message).toContain(JSON.stringify(attachment.path))
  expect(sent.images).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '移除图片：missing.png' }))
  expect(onRemoveImage).toHaveBeenCalledExactlyOnceWith('missing')
})

test('仅附件消息不显示路径说明，类似附件说明但不完整的正文保持原样', () => {
  const { message } = messageWithAttachments('', [
    { id: 'file', type: 'file', name: 'notes.txt', path: '/host/attachments/upload-doc/file-notes.txt' },
  ])
  const renderMessage = (text: string) => (
    <TooltipProvider>
      <ChatMessage message={userMessage(text)} tools={{}} />
    </TooltipProvider>
  )
  const { container, rerender } = render(renderMessage(message))
  expect(container).toHaveTextContent('notes.txt')
  expect(container).not.toHaveTextContent('附加文件')
  expect(container).not.toHaveTextContent('/host/attachments')
  const malformed = '请解释这段文字\n\n附加文件（Host 路径，请按需读取）：\n- "notes.txt"：路径不完整'
  expect(container.querySelector('[data-message-body]')).toBeNull()
  rerender(renderMessage(malformed))
  expect(container.querySelector('[data-message-body]')?.textContent).toBe(malformed)
})

test('图片链接显示缩略图，原地打开预览、缩放，Esc 关闭后返回焦点', async () => {
  const user = userEvent.setup()
  render(<MarkdownContent>[查看实测截图](http://127.0.0.1:31415/out/sidebar-after.png?raw=1)</MarkdownContent>)
  const trigger = screen.getByRole('button', { name: '预览图片：查看实测截图' })
  expect(screen.getByRole('img', { name: '查看实测截图' })).toHaveAttribute(
    'src',
    'http://127.0.0.1:31415/out/sidebar-after.png?raw=1',
  )
  await user.click(trigger)
  expect(await screen.findByRole('dialog', { name: '图片预览' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: '图片缩放比例' })).toHaveTextContent('适应窗口')
  await user.click(screen.getByRole('button', { name: '放大图片' }))
  expect(screen.getByRole('combobox', { name: '图片缩放比例' })).toHaveTextContent('125%')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
})

test('会话相对路径通过文件接口读取，缩略图、预览和下载均使用返回的图片而非 Web URL', async () => {
  const user = userEvent.setup()
  const loadImage = vi.fn(async () => preview())
  const { container } = render(
    <MessageImageLoaderContext value={loadImage}>
      <MarkdownContent>[![侧栏截图](out/sidebar.png)](out/sidebar.png)</MarkdownContent>
    </MessageImageLoaderContext>,
  )
  expect(container.querySelector('a button, button button, p div')).toBeNull()
  const image = await screen.findByRole('img', { name: '侧栏截图' })
  expect(loadImage).toHaveBeenCalledExactlyOnceWith('out/sidebar.png')
  expect(image).toHaveAttribute('src', dataUrl)
  await user.click(screen.getByRole('button', { name: '预览图片：侧栏截图' }))
  expect(screen.getByRole('img', { name: '图片大图预览，第 1 张' })).toHaveAttribute('src', dataUrl)
  expect(screen.getByRole('link', { name: '下载原图' })).toHaveAttribute('href', dataUrl)
})

test('远程图片加载失败不显示图标和文案，消息更新图片后重新显示缩略图', () => {
  const { rerender } = render(<MarkdownContent>![截图](https://example.test/old.png)</MarkdownContent>)
  fireEvent.error(screen.getByRole('img', { name: '截图' }))
  expect(screen.getByRole('status', { name: '图片加载失败' })).toBeInTheDocument()
  expect(screen.queryByText('图片加载失败')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '预览图片：截图' })).not.toBeInTheDocument()
  rerender(<MarkdownContent>![截图](https://example.test/new.png)</MarkdownContent>)
  expect(screen.getByRole('img', { name: '截图' })).toHaveAttribute('src', 'https://example.test/new.png')
  expect(screen.queryByText('图片加载失败')).not.toBeInTheDocument()
})

test('普通网页链接保持原样，图片扩展名只检查路径而不是查询参数', () => {
  render(
    <MarkdownContent>
      {'[文档](https://example.test/docs?file=photo.png)\n\n[图片](https://example.test/SCREENSHOT.PNG#preview)'}
    </MarkdownContent>,
  )
  expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('target', '_blank')
  expect(screen.getByRole('button', { name: '预览图片：图片' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '预览图片：文档' })).not.toBeInTheDocument()
})

test('本地文件读取失败不退回 Web 地址，没有会话读取器时也不请求网页', async () => {
  const loadImage = vi.fn().mockRejectedValue(new Error('ENOENT'))
  const { rerender } = render(
    <MessageImageLoaderContext value={loadImage}>
      <MarkdownContent>![截图](out/missing.png)</MarkdownContent>
    </MessageImageLoaderContext>,
  )
  expect(
    await screen.findByRole('status', { name: '图片不存在或无法读取，请确认路径相对于当前会话工作目录。' }),
  ).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '打开原图' })).not.toBeInTheDocument()
  rerender(<MarkdownContent>![截图](out/missing.png)</MarkdownContent>)
  expect(await screen.findByRole('status', { name: '当前内容没有可用的会话文件读取器。' })).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

test('本地图片读取失败后可重试并恢复预览', async () => {
  const loadImage = vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(preview())
  render(
    <MessageImageLoaderContext value={loadImage}>
      <MarkdownContent>![截图](out/retry.png)</MarkdownContent>
    </MessageImageLoaderContext>,
  )
  expect(
    await screen.findByRole('status', { name: '图片不存在或无法读取，请确认路径相对于当前会话工作目录。' }),
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '预览失败点击重试' }))
  expect(await screen.findByRole('img', { name: '截图' })).toHaveAttribute('src', dataUrl)
  expect(loadImage).toHaveBeenCalledTimes(2)
})

test('会话切换后清空旧图片，丢弃之前的异步结果，不串用同名文件', async () => {
  let finish!: (value: FilePreview) => void
  const first = vi.fn(
    () =>
      new Promise<FilePreview>((resolve) => {
        finish = resolve
      }),
  )
  const second = vi.fn(async () => preview('data:image/png;base64,ZGVm'))
  const view = (loadImage: (path: string) => Promise<FilePreview>) => (
    <MessageImageLoaderContext value={loadImage}>
      <MarkdownContent>![截图](out/same.png)</MarkdownContent>
    </MessageImageLoaderContext>
  )
  const { rerender } = render(view(first))
  await waitFor(() => expect(first).toHaveBeenCalledOnce())
  rerender(view(second))
  expect(await screen.findByRole('img', { name: '截图' })).toHaveAttribute('src', 'data:image/png;base64,ZGVm')
  await act(async () => finish(preview()))
  expect(screen.getByRole('img', { name: '截图' })).toHaveAttribute('src', 'data:image/png;base64,ZGVm')
  rerender(view(first))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

test('URL 编码的本地文件名在读取前解码，超大图片显示明确原因', async () => {
  const loadImage = vi.fn(async (): Promise<FilePreview> => ({
    kind: 'unsupported',
    relativePath: 'out/截图 1.png',
    reason: 'too-large',
  }))
  render(
    <MessageImageLoaderContext value={loadImage}>
      <MarkdownContent>![截图](out/%E6%88%AA%E5%9B%BE%201.png)</MarkdownContent>
    </MessageImageLoaderContext>,
  )
  expect(await screen.findByRole('status', { name: '图片超过 8 MiB，无法预览。' })).toBeInTheDocument()
  expect(loadImage).toHaveBeenCalledExactlyOnceWith('out/截图 1.png')
})

test('文件接口返回文本时不作为图片展示', async () => {
  const loadImage = vi.fn(async (): Promise<FilePreview> => ({
    kind: 'text',
    relativePath: 'out/fake.png',
    content: 'not an image',
    revision: 'r',
  }))
  render(
    <MessageImageLoaderContext value={loadImage}>
      <MarkdownContent>![截图](out/fake.png)</MarkdownContent>
    </MessageImageLoaderContext>,
  )
  expect(await screen.findByRole('status', { name: '该文件不是可预览的图片。' })).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

test('Conversation 注入自己的读取器，未绑定的只读会话不继承外层主会话的文件作用域', async () => {
  const loadImage = vi.fn(async () => preview())
  const conversation = (bound: boolean) => (
    <TooltipProvider>
      <MessageImageLoaderContext value={loadImage}>
        <Conversation
          chat={{ ...emptyChat, messages: [assistantMessage('![截图](out/sidebar.png)', 1)] }}
          loadImage={bound ? loadImage : undefined}
          readOnly
          canEditMessages={false}
          onEditMessage={vi.fn()}
          onForkReply={vi.fn()}
          onCopyError={vi.fn()}
        />
      </MessageImageLoaderContext>
    </TooltipProvider>
  )
  const { rerender } = render(conversation(true))
  expect(await screen.findByRole('img', { name: '截图' })).toHaveAttribute('src', dataUrl)
  expect(loadImage).toHaveBeenCalledOnce()
  rerender(conversation(false))
  expect(await screen.findByRole('status', { name: '当前内容没有可用的会话文件读取器。' })).toBeInTheDocument()
  expect(loadImage).toHaveBeenCalledOnce()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
