import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownContent } from '../src/ui/content/markdown-content'
import { fileLinkTarget, MarkdownLinkContext, MarkdownWorkingDirectoryContext } from '../src/ui/content/markdown-link'

afterEach(cleanup)

test('文件链接解析相对路径、空格、Windows 路径和行列，拒绝执行协议', () => {
  expect(fileLinkTarget('src/main.ts:42:3', '/workspace')?.label).toBe('/workspace/src/main.ts（第 42 行，第 3 列）')
  expect(fileLinkTarget('/workspace/a%20b.ts#L12-L18')?.path).toBe('/workspace/a b.ts')
  expect(fileLinkTarget('file:///C:/project/main.ts:42')?.path).toBe('C:/project/main.ts')
  expect(fileLinkTarget('C:\\project\\main.ts:42')?.line).toBe('42')
  expect(fileLinkTarget('javascript:alert(1)')).toBeNull()
  expect(fileLinkTarget('javascript:123')).toBeNull()
  expect(fileLinkTarget('https://example.com/a.ts:42')).toBeNull()
  expect(fileLinkTarget('#section')).toBeNull()
})

test('文件链接使用会话工作目录打开实际文件，行号保留在说明中', async () => {
  const openFile = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(
    <MarkdownLinkContext value={{ openFile }}>
      <MarkdownWorkingDirectoryContext value="/workspace">
        <MarkdownContent>[入口](src/main.ts:42) 和 [技能](file:///workspace/SKILL.md)</MarkdownContent>
      </MarkdownWorkingDirectoryContext>
    </MarkdownLinkContext>,
  )
  await user.click(screen.getByRole('button', { name: /入口/ }))
  expect(openFile).toHaveBeenCalledWith('/workspace/src/main.ts', { line: '42', column: undefined, session: undefined })
  await user.click(screen.getByRole('button', { name: '技能' }))
  expect(openFile).toHaveBeenCalledWith('/workspace/SKILL.md', {
    line: undefined,
    column: undefined,
    session: undefined,
  })
})

test('远程文件点击复制路径和行列，不导航到网页', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  render(<MarkdownContent>{'[文件](</remote/a b.ts:12:3>)'}</MarkdownContent>)
  await user.click(screen.getByRole('button', { name: /文件/ }))
  expect(copy).toHaveBeenCalledWith('/remote/a b.ts:12:3')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('路径已复制')
})

test('网页预览按需读取，键盘聚焦显示卡片，Esc 关闭且链接保持可打开', async () => {
  const user = userEvent.setup()
  const loadPreview = vi.fn().mockResolvedValue({
    url: 'https://example.com/docs',
    title: '文档标题',
    description: '文档摘要',
    image: 'https://example.com/cover.png',
  })
  render(
    <MarkdownLinkContext value={{ loadPreview }}>
      <MarkdownContent>[官方文档](https://example.com/docs)</MarkdownContent>
    </MarkdownLinkContext>,
  )
  expect(loadPreview).not.toHaveBeenCalled()
  await user.tab()
  expect(await screen.findByText('文档标题')).toBeVisible()
  expect(screen.getByText('文档摘要')).toBeVisible()
  expect(screen.getByRole('link', { name: '打开' })).toHaveAttribute('href', 'https://example.com/docs')
  expect(loadPreview).toHaveBeenCalledOnce()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('link', { name: '打开' })).toHaveFocus()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('link', { name: '官方文档' })).toHaveFocus()
})

test('网页预览读取失败仍能打开原始链接', async () => {
  const user = userEvent.setup()
  const loadPreview = vi.fn().mockRejectedValue(new Error('离线'))
  const { container } = render(
    <MarkdownLinkContext value={{ loadPreview }}>
      <MarkdownContent>[文档](https://example.com)</MarkdownContent>
    </MarkdownLinkContext>,
  )
  await user.tab()
  expect(await screen.findByText('暂时无法预览，可直接打开网页。')).toBeVisible()
  expect(screen.getByRole('link', { name: '打开' })).toHaveAttribute('href', 'https://example.com')
  expect(container.querySelector('a button')).toBeNull()
})

test('危险协议保持不可点击，代码块和行内代码不误识别为文件链接', () => {
  const { container } = render(
    <MarkdownContent>
      {'[危险](javascript:alert) [数据](data:text/html,test) `src/main.ts`\n\n```ts\nconst path = "src/main.ts"\n```'}
    </MarkdownContent>,
  )
  expect(container.querySelector('a[href^="javascript:"], a[href^="data:"], button.pi-file-link')).toBeNull()
  expect(screen.getByText('src/main.ts')).toHaveClass('pi-inline-code')
})

test('指针移至卡片后不会关闭，离开后关闭', async () => {
  render(<MarkdownContent>[文档](https://example.com)</MarkdownContent>)
  const link = screen.getByRole('link', { name: '文档' })
  fireEvent.pointerEnter(link, { pointerType: 'mouse' })
  const card = await screen.findByRole('dialog', { name: '链接预览' })
  fireEvent.pointerLeave(link)
  fireEvent.pointerEnter(card)
  expect(card).toBeVisible()
  fireEvent.pointerLeave(card)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})
