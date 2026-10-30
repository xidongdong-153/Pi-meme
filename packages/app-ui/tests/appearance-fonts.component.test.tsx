import '@testing-library/jest-dom/vitest'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppearanceSettings, InstalledFont } from '@pi-meme/contracts/settings'
import { ThemeSettings } from '@pi-meme/settings/ui/theme-settings'
import { defaultAppearance } from '@pi-meme/settings/shared/appearance'
import { builtinThemes } from '@pi-meme/settings/shared/themes'

const fonts: InstalledFont[] = [
  { family: 'Arial', styles: ['regular', 'bold', 'italic', 'bold-italic'], monospace: false },
  { family: 'Menlo', styles: ['regular', 'bold'], monospace: true },
  { family: '单样式', styles: ['bold-italic'], monospace: false },
]

afterEach(cleanup)
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

function setup(loadFonts = vi.fn(async () => fonts), initial = defaultAppearance()) {
  const onAppearance = vi.fn<(value: AppearanceSettings) => void>()
  function Page() {
    const [appearance, setAppearance] = useState(initial)
    return (
      <ThemeSettings
        snapshot={{ settings: { themeId: 'dark', appearance }, themes: builtinThemes, errors: [], themesDirectory: '' }}
        onAppearance={(next) => {
          onAppearance(next)
          setAppearance(next)
        }}
        onPreview={() => {}}
        onFlush={async () => {}}
        onOpenDirectory={() => {}}
        onReload={() => {}}
        onImport={() => {}}
        onExport={() => {}}
        loadFonts={loadFonts}
      />
    )
  }
  render(
    <StrictMode>
      <Page />
    </StrictMode>,
  )
  return { loadFonts, onAppearance, user: userEvent.setup() }
}

test('进入外观页即预读取，严格模式和三个选择器共用请求，加载中仍可选默认项', async () => {
  let finish!: (value: InstalledFont[]) => void
  const pending = new Promise<InstalledFont[]>((resolve) => {
    finish = resolve
  })
  const f = setup(vi.fn(() => pending))
  expect(f.loadFonts).toHaveBeenCalledTimes(1)
  expect(f.onAppearance).not.toHaveBeenCalled()

  for (const [label, option] of [
    ['界面字体', '跟随主题'],
    ['内容字体', '与界面字体相同'],
    ['代码字体', '系统'],
  ]) {
    await f.user.click(screen.getByRole('button', { name: label }))
    expect(within(screen.getByRole('dialog', { name: `${label}选择器` })).getByRole('status')).toHaveTextContent(
      '正在读取字体',
    )
    await f.user.click(screen.getByRole('option', { name: option }))
  }
  expect(f.onAppearance.mock.lastCall?.[0].shared.fonts).toEqual({
    content: 'inherit',
    code: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  })
  expect(f.loadFonts).toHaveBeenCalledTimes(1)
  await act(async () => finish(fonts))

  for (const label of ['界面字体', '内容字体', '代码字体']) {
    await f.user.click(screen.getByRole('button', { name: label }))
    expect(within(screen.getByRole('dialog', { name: `${label}选择器` })).queryByRole('status')).not.toBeInTheDocument()
    expect(within(screen.getByRole('listbox', { name: label })).getByRole('option', { name: 'Menlo' })).toBeVisible()
    await f.user.keyboard('{Escape}')
  }
  expect(f.loadFonts).toHaveBeenCalledTimes(1)
})

test('字体载入后选择实际可用样式，缺失的样式保持禁用', async () => {
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '界面字体' }))
  await f.user.click(await screen.findByRole('option', { name: '单样式' }))
  expect(f.onAppearance.mock.lastCall?.[0].shared).toEqual({
    fonts: { ui: '"单样式", sans-serif' },
    fontStyles: { ui: 'bold-italic' },
  })
  await f.user.click(screen.getByRole('combobox', { name: '界面字体样式' }))
  for (const label of ['常规', '粗体', '斜体'])
    expect(screen.getByRole('option', { name: label })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('option', { name: '粗斜体' })).not.toHaveAttribute('aria-disabled', 'true')
  expect(f.loadFonts).toHaveBeenCalledTimes(1)
})

test('代码字体直接按原生等宽属性排序，搜索和重复打开不调用 Canvas', async () => {
  const canvas = vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '代码字体' }))
  await screen.findByRole('option', { name: 'Menlo' })
  expect(canvas).not.toHaveBeenCalled()
  expect(screen.getAllByRole('option').map((node) => node.textContent)).toEqual([
    '跟随主题',
    '系统',
    'Menlo',
    'Arial',
    '单样式',
  ])
  await f.user.type(screen.getByRole('textbox', { name: '搜索代码字体' }), '单')
  expect(screen.getAllByRole('option').map((node) => node.textContent)).toEqual(['跟随主题', '系统', '单样式'])
  await f.user.keyboard('{Escape}')
  await f.user.click(screen.getByRole('button', { name: '代码字体' }))
  expect(canvas).not.toHaveBeenCalled()
  expect(f.loadFonts).toHaveBeenCalledTimes(1)
})

test('预读取失败只在字体选择器内提示，重试后恢复列表且不修改其他外观设置', async () => {
  const loadFonts = vi.fn<() => Promise<InstalledFont[]>>()
  loadFonts.mockRejectedValueOnce(new Error('测试字体读取失败')).mockResolvedValueOnce(fonts)
  const f = setup(loadFonts)
  await f.user.click(screen.getByRole('button', { name: '界面字体' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('测试字体读取失败')
  expect(screen.getByRole('button', { name: '浅色模式' })).toBeEnabled()
  expect(screen.getByRole('option', { name: '跟随主题' })).toBeEnabled()
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByRole('option', { name: 'Menlo' })).toBeVisible()
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(loadFonts).toHaveBeenCalledTimes(2)
  expect(f.onAppearance).not.toHaveBeenCalled()
})

test('原生列表不包含已保存字体时保留配置和选择器文字，不自动改写字体', async () => {
  const f = setup(
    vi.fn(async () => fonts),
    {
      ...defaultAppearance(),
      shared: { fonts: { ui: '"旧字体", sans-serif' }, fontStyles: { ui: 'bold' } },
    },
  )
  const trigger = screen.getByRole('button', { name: '界面字体' })
  expect(trigger).toHaveTextContent('旧字体')
  await f.user.click(trigger)
  await screen.findByRole('option', { name: 'Arial' })
  expect(trigger).toHaveTextContent('旧字体')
  expect(screen.getByRole('combobox', { name: '界面字体样式' })).toHaveTextContent('粗体')
  expect(f.onAppearance).not.toHaveBeenCalled()
})
