import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LinkedFilePanel, type LinkedFileTab } from '../src/panels/linked-file-panel'
import type { FilePreview } from '@pi-meme/contracts/app-host'

vi.mock('@pi-meme/file-directory/ui/file-editor', () => ({
  FileEditor: ({ content, line }: { content: string; line?: number }) => (
    <pre data-testid="code" data-line={line}>
      {content}
    </pre>
  ),
}))
afterEach(cleanup)
const session = { hostId: 'remote', sessionId: 'session' }
const tab: LinkedFileTab = { id: 'file', path: '/project/README.md', session }
const bridge = {
  getProjectApps: vi.fn(async () => [
    { id: 'vscode' as const, name: 'VS Code' },
    { id: 'finder' as const, name: '系统文件管理器' },
  ]),
  openProject: vi.fn(async () => {}),
}

test('Markdown 标签预览可切换源码，本机打开菜单使用文件路径', async () => {
  const user = userEvent.setup()
  const load = vi.fn(async (): Promise<FilePreview> => ({
    kind: 'text',
    relativePath: tab.path,
    content: '# 文档标题',
    revision: '',
  }))
  render(<LinkedFilePanel tab={tab} load={load} bridge={bridge} local />)
  expect(await screen.findByRole('heading', { name: '文档标题' })).toBeVisible()
  expect(load).toHaveBeenCalledWith(session, tab.path)
  await user.click(screen.getByRole('button', { name: '源码' }))
  expect(await screen.findByTestId('code')).toHaveTextContent('# 文档标题')
  await user.click(screen.getByRole('button', { name: '打开方式' }))
  await user.click(await screen.findByRole('menuitem', { name: 'VS Code' }))
  expect(bridge.openProject).toHaveBeenCalledWith('vscode', tab.path)
})

test('远程标签不显示本机应用，并丢弃切换前的异步读取结果', async () => {
  const user = userEvent.setup()
  let finish!: (value: FilePreview) => void
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue({ kind: 'text', relativePath: 'next.md', content: '# 新文件', revision: '' })
  const { rerender } = render(<LinkedFilePanel tab={tab} load={load} bridge={bridge} local={false} />)
  rerender(<LinkedFilePanel tab={{ ...tab, path: '/remote/next.md' }} load={load} bridge={bridge} local={false} />)
  expect(await screen.findByRole('heading', { name: '新文件' })).toBeVisible()
  finish({ kind: 'text', relativePath: tab.path, content: '# 旧文件', revision: '' })
  await waitFor(() => expect(screen.queryByRole('heading', { name: '旧文件' })).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: '打开方式' }))
  expect(screen.queryByRole('menuitem', { name: 'VS Code' })).not.toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: '复制路径' })).toBeVisible()
})

test('父层状态更新保留文件内容，仅手动刷新时重新读取', async () => {
  const user = userEvent.setup()
  const load = vi.fn(async (): Promise<FilePreview> => ({
    kind: 'text',
    relativePath: tab.path,
    content: '# 保留内容',
    revision: '',
  }))
  const { rerender } = render(<LinkedFilePanel tab={tab} load={load} bridge={bridge} local />)
  const content = await screen.findByRole('heading', { name: '保留内容' })
  for (let i = 0; i < 3; i++) rerender(<LinkedFilePanel tab={tab} load={load} bridge={{ ...bridge }} local />)
  expect(load).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('heading', { name: '保留内容' })).toBe(content)
  expect(screen.queryByText('正在读取文件…')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重新读取文件' }))
  await screen.findByRole('heading', { name: '保留内容' })
  expect(load).toHaveBeenCalledTimes(2)
})

test('行号引用显示源码并传递定位，读取失败保留重试', async () => {
  const user = userEvent.setup()
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('文件不存在'))
    .mockResolvedValue({ kind: 'text', relativePath: tab.path, content: '正文', revision: '' })
  render(<LinkedFilePanel tab={{ ...tab, line: 42 }} load={load} bridge={bridge} local={false} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('文件不存在')
  await user.click(screen.getByRole('button', { name: '重新读取文件' }))
  expect(await screen.findByTestId('code')).toHaveAttribute('data-line', '42')
})
