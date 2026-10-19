import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { MarkdownContent } from '../src/ui/content/markdown-content'
import { normalizeMermaidSvg, readMermaidTheme, renderMermaid } from '../src/ui/content/mermaid-renderer'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

const code = 'flowchart LR\n A[开始] --> B[完成]'
const markdown = (source = code) => `\`\`\`mermaid\n${source}\n\`\`\``
function diagram(label = '测试图表') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:120px" viewBox="-5 -10 120 60"><text>${label}</text></svg>`
}

beforeEach(() => {
  mermaid.initialize.mockReset()
  mermaid.render.mockReset().mockImplementation(async () => ({ svg: diagram() }))
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-appearance')
})

test('Agent 流式更新不渲染图表，本轮结束后使用完整源码渲染一次', async () => {
  const view = (isLive: boolean, source: string) => (
    <TooltipProvider>
      <AssistantTurnView
        turn={{
          type: 'assistant_turn',
          key: 'turn',
          activities: [],
          images: [],
          isLive,
          finalText: markdown(source),
        }}
      />
    </TooltipProvider>
  )
  const { rerender } = render(view(true, 'flowchart LR\n A['))
  expect(screen.getByRole('button', { name: '展开图表' })).toBeDisabled()
  expect(mermaid.render).not.toHaveBeenCalled()
  rerender(view(true, code))
  expect(screen.getByRole('button', { name: '展开图表' })).toBeDisabled()
  expect(mermaid.render).not.toHaveBeenCalled()
  rerender(view(false, code))
  expect(await screen.findByRole('img', { name: 'Mermaid 图表' })).toBeVisible()
  expect(mermaid.render).toHaveBeenCalledExactlyOnceWith(expect.any(String), code)
})

test('图表支持源码切换、复制、SVG 下载、展开缩放和关闭后返回焦点', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:diagram-test')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    },
  )
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const { rerender } = render(<MarkdownContent>{markdown()}</MarkdownContent>)
  await screen.findByRole('img', { name: 'Mermaid 图表' })

  await user.click(screen.getByRole('button', { name: '图表操作' }))
  await user.click(screen.getByRole('menuitem', { name: '查看源码' }))
  expect(screen.getByRole('button', { name: '复制代码' })).toBeVisible()
  rerender(<MarkdownContent>{`${markdown()}\n\n后续正文`}</MarkdownContent>)
  expect(screen.getByRole('button', { name: '复制代码' })).toBeVisible()
  expect(mermaid.render).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: '图表操作' }))
  await user.click(screen.getByRole('menuitem', { name: '复制源码' }))
  expect(writeText).toHaveBeenCalledExactlyOnceWith(code)
  await user.click(screen.getByRole('button', { name: '图表操作' }))
  await user.click(screen.getByRole('menuitem', { name: '查看图表' }))

  const expand = screen.getByRole('button', { name: '展开图表' })
  await user.click(expand)
  const dialog = await screen.findByRole('dialog', { name: '图表预览' })
  expect(dialog).toBeVisible()
  expect(screen.queryByRole('button', { name: '上一张图片' })).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '图表缩放比例' })).toHaveTextContent('适应窗口')
  await user.click(screen.getByRole('button', { name: '放大图表' }))
  expect(screen.getByRole('combobox', { name: '图表缩放比例' })).toHaveTextContent('125%')
  await user.click(screen.getByRole('button', { name: '下载 SVG' }))
  expect(createObjectURL).toHaveBeenCalledTimes(1)
  expect(createObjectURL.mock.calls[0][0].type).toBe('image/svg+xml;charset=utf-8')
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('diagram.svg')
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:diagram-test'))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(expand).toHaveFocus()
  expect(mermaid.render).toHaveBeenCalledTimes(1)
})

test('渲染失败保留源码和其他正文，更新源码后仍可继续渲染', async () => {
  mermaid.render.mockRejectedValueOnce(new Error('语法错误'))
  const { rerender } = render(<MarkdownContent>{`${markdown('flowchart LR\n A[')}\n\n其他正文`}</MarkdownContent>)
  expect(await screen.findByText('图表无法渲染，请检查源码。')).toBeVisible()
  expect(screen.getByText('其他正文')).toBeVisible()
  expect(screen.getByRole('button', { name: '复制代码' })).toBeVisible()
  expect(screen.getByRole('button', { name: '展开图表' })).toBeDisabled()
  rerender(<MarkdownContent>{markdown()}</MarkdownContent>)
  expect(await screen.findByRole('img', { name: 'Mermaid 图表' })).toBeVisible()
})

test('源码更新后丢弃旧异步结果，主题变化重新生成图表', async () => {
  let finish!: (value: { svg: string }) => void
  mermaid.render.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { rerender } = render(<MarkdownContent>{markdown('旧源码')}</MarkdownContent>)
  await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
  rerender(<MarkdownContent>{markdown('新源码')}</MarkdownContent>)
  mermaid.render.mockResolvedValueOnce({ svg: diagram('新图表') })
  await act(async () => finish({ svg: diagram('旧图表') }))
  const image = await screen.findByRole('img', { name: 'Mermaid 图表' })
  expect(decodeURIComponent(image.getAttribute('src')!)).toContain('新图表')
  expect(decodeURIComponent(image.getAttribute('src')!)).not.toContain('旧图表')
  expect(mermaid.render).toHaveBeenCalledTimes(2)

  act(() => {
    document.documentElement.dataset.appearance = 'light'
    document.documentElement.style.setProperty('--color-surface', '#fafafa')
  })
  await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(3))
  expect(mermaid.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      themeVariables: expect.objectContaining({ darkMode: false, primaryColor: '#fafafa' }),
    }),
  )
  await screen.findByRole('img', { name: 'Mermaid 图表' })
})

test('SVG 规范化保留中文与视口，修复命名空间并移除链接和事件', () => {
  const svg =
    normalizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="-5 -10 120 60" style="max-width:120px" onload="alert(1)">
    <a xlink:href="https://example.test"><text>中文节点</text></a>
    <defs><path id="shape" d="M0 0" /></defs><use xlink:href="#shape" />
    <script>alert(1)</script>
  </svg>`)
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(parsed.querySelector('parsererror')).toBeNull()
  expect(parsed.documentElement.getAttribute('viewBox')).toBe('-5 -10 120 60')
  expect(parsed.documentElement.getAttribute('width')).toBe('120')
  expect(parsed.documentElement.getAttribute('height')).toBe('60')
  expect(parsed.documentElement.getAttribute('onload')).toBeNull()
  expect(parsed.querySelector('a, script')).toBeNull()
  expect(parsed.querySelector('text')?.textContent).toBe('中文节点')
  expect(parsed.querySelector('use')?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#shape')
  expect(() => normalizeMermaidSvg('<svg viewBox="0 0 0 60"/>')).toThrow('SVG 尺寸')
})

test('空源码与超长源码在加载渲染引擎前失败', async () => {
  await expect(renderMermaid(' ', readMermaidTheme())).rejects.toThrow('源码为空')
  await expect(renderMermaid('a'.repeat(50001), readMermaidTheme())).rejects.toThrow('50000')
  expect(mermaid.render).not.toHaveBeenCalled()
})
