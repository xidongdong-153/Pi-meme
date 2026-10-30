import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopSettings, SettingsSnapshot } from '@pi-meme/contracts/settings'
import { AccessSettings } from '@pi-meme/permissions/ui/access-settings'
import { SettingsPage } from '@pi-meme/settings/ui/settings-page'
import { useSettings } from '@pi-meme/settings/ui/use-settings'

afterEach(cleanup)

function snapshot(settings: Partial<DesktopSettings> = {}): SettingsSnapshot {
  return {
    settings: { themeId: 'dark', showComposerHint: true, showContextUsage: true, ...settings },
    themes: [],
    themesDirectory: '/test/themes',
    errors: [],
  }
}

function deferred() {
  let resolve!: (value: SettingsSnapshot) => void
  const promise = new Promise<SettingsSnapshot>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function setup(busy = false) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  let stored = snapshot()
  const bridge = {
    getSettings: vi.fn(async () => stored),
    saveSettings: vi.fn(async (value: DesktopSettings) => (stored = snapshot({ ...stored.settings, ...value }))),
    saveEditorSettings: vi.fn(
      async (value: Pick<DesktopSettings, 'showComposerHint' | 'showContextUsage'>) =>
        (stored = snapshot({ ...stored.settings, ...value })),
    ),
    getSubagents: vi.fn(async () => ({ directory: '/test/agents', agents: [], diagnostics: [] })),
    reloadSubagents: vi.fn(async () => ({ directory: '/test/agents', agents: [], diagnostics: [] })),
    selectTheme: vi.fn(async () => stored),
    reloadThemes: vi.fn(async () => stored),
    openThemesDirectory: vi.fn(async () => {}),
    saveAppearance: vi.fn(async () => stored),
    getInstalledFonts: vi.fn(async () => []),
    importTheme: vi.fn(async () => null),
    exportTheme: vi.fn(async () => {}),
    getStorageInfo: vi.fn(async () => ({ hostId: 'test-host', dataRoot: '/test/data' })),
    getInstructions: vi.fn(async () => ({ cwd: '/test/project', entries: [] })),
    saveInstruction: vi.fn(async () => ({ snapshot: { cwd: '/test/project', entries: [] } })),
    reconnectModels: vi.fn(async () => {}),
  }
  const saveSubagentDefaults = vi.fn(async (patch: import('@pi-meme/contracts/settings').SubagentDefaultsPatch) => {
    const defaults = { model: null, thinkingLevel: null, ...stored.settings.subagentDefaults, ...patch }
    stored = snapshot({ ...stored.settings, subagentDefaults: defaults })
    return defaults
  })
  const settingsBridge = { ...bridge, saveSubagentDefaults }
  let current!: ReturnType<typeof useSettings>
  function Harness() {
    const settings = useSettings(settingsBridge, true, false, false)
    current = settings
    return (
      <SettingsPage
        section="general"
        snapshot={settings.snapshot}
        error={settings.error}
        bridge={bridge}
        cwd="/test/project"
        busy={busy}
        onDirty={vi.fn()}
        onSaving={vi.fn()}
        onBeforeRestart={async () => {}}
        accessSettings={<AccessSettings supported busy={busy} saving={settings.saving} onSave={vi.fn()} />}
        onEditor={(value) => void settings.saveEditor(value)}
        onAppearance={vi.fn()}
        onPreview={vi.fn()}
        onFlush={async () => {}}
        loadFonts={async () => []}
        onImport={vi.fn()}
        onExport={vi.fn()}
        onReload={vi.fn()}
        onOpenDirectory={vi.fn()}
      />
    )
  }
  render(<Harness />)
  return { bridge: settingsBridge, settings: () => current }
}

async function switches() {
  const hint = screen.getByRole('switch', { name: '显示预测消息' })
  const context = screen.getByRole('switch', { name: '显示上下文窗口使用情况' })
  await waitFor(() => expect(hint).toBeEnabled())
  return { hint, context }
}

test('点击立即切换，保存期间保持可操作且不显示正在保存提示', async () => {
  const pending = deferred()
  const { bridge } = setup()
  bridge.saveEditorSettings.mockImplementationOnce(() => pending.promise)
  const { hint, context } = await switches()
  fireEvent.click(hint)
  expect(hint).not.toBeChecked()
  expect(hint).toBeEnabled()
  expect(context).toBeEnabled()
  expect(screen.queryByText(/正在保存/)).not.toBeInTheDocument()
  await waitFor(() => expect(bridge.saveEditorSettings).toHaveBeenCalledOnce())
  expect(bridge.saveSettings).not.toHaveBeenCalled()
  await act(async () => pending.resolve(snapshot({ showComposerHint: false })))
  expect(hint).not.toBeChecked()
})

test('会话运行时两个显示开关仍可切换', async () => {
  setup(true)
  const { hint, context } = await switches()
  fireEvent.click(hint)
  fireEvent.click(context)
  expect(hint).not.toBeChecked()
  expect(context).not.toBeChecked()
})

test('连续切换按顺序保存，旧响应不覆盖最后一次选择', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  const { bridge } = setup()
  bridge.saveEditorSettings
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => third.promise)
  const { hint, context } = await switches()
  fireEvent.click(hint)
  fireEvent.click(context)
  fireEvent.click(hint)
  expect(hint).toBeChecked()
  expect(context).not.toBeChecked()
  await waitFor(() => expect(bridge.saveEditorSettings).toHaveBeenCalledTimes(1))
  await act(async () => first.resolve(snapshot({ showComposerHint: false })))
  expect(hint).toBeChecked()
  expect(context).not.toBeChecked()
  await waitFor(() => expect(bridge.saveEditorSettings).toHaveBeenCalledTimes(2))
  await act(async () => second.resolve(snapshot({ showComposerHint: false, showContextUsage: false })))
  expect(hint).toBeChecked()
  expect(context).not.toBeChecked()
  await waitFor(() => expect(bridge.saveEditorSettings).toHaveBeenCalledTimes(3))
  expect(bridge.saveEditorSettings).toHaveBeenLastCalledWith({ showComposerHint: true, showContextUsage: false })
  await act(async () => third.resolve(snapshot({ showComposerHint: true, showContextUsage: false })))
  expect(hint).toBeChecked()
  expect(context).not.toBeChecked()
})

test('保存失败才显示错误并恢复已保存的状态，之后可重试', async () => {
  const { bridge } = setup()
  bridge.saveEditorSettings.mockRejectedValueOnce(new Error('连接中断'))
  const { hint } = await switches()
  fireEvent.click(hint)
  expect(hint).not.toBeChecked()
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')
  expect(hint).toBeChecked()
  expect(hint).toBeEnabled()
  fireEvent.click(hint)
  await waitFor(() => expect(bridge.saveEditorSettings).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(hint).not.toBeChecked()
})

test('同时保存运行时设置不覆盖编辑器选择，运行时请求不再携带显示字段', async () => {
  const editor = deferred()
  const runtime = deferred()
  const f = setup()
  f.bridge.saveEditorSettings.mockImplementationOnce(() => editor.promise)
  f.bridge.saveSettings.mockImplementationOnce(() => runtime.promise)
  const { hint } = await switches()
  fireEvent.click(hint)
  act(() => {
    void f.settings().saveAccessMode('full-access')
  })
  await waitFor(() => expect(f.bridge.saveSettings).toHaveBeenCalledOnce())
  expect(f.bridge.saveSettings.mock.calls[0][0]).not.toHaveProperty('showComposerHint')
  expect(f.bridge.saveSettings.mock.calls[0][0]).not.toHaveProperty('showContextUsage')
  await act(async () => editor.resolve(snapshot({ showComposerHint: false })))
  expect(hint).not.toBeChecked()
  await act(async () => runtime.resolve(snapshot({ defaultAccessMode: 'full-access' })))
  expect(hint).not.toBeChecked()
})

test('连接恢复后成功刷新设置，清除之前的连接错误并应用新快照', async () => {
  const f = setup()
  await switches()
  f.bridge.getSettings.mockRejectedValueOnce(new Error('Host 连接已暂停，请恢复连接后继续'))
  await act(async () => f.settings().refresh())
  expect(f.settings().error).toContain('Host 连接已暂停')
  f.bridge.getSettings.mockResolvedValueOnce(snapshot({ showComposerHint: false }))
  await act(async () => f.settings().refresh())
  expect(f.settings().snapshot?.settings.showComposerHint).toBe(false)
  expect(f.settings().error).toBe('')
})

test('子代理默认配置逐项保存、失败回退并可重试，运行中也可修改', async () => {
  const context = setup(true)
  await switches()
  context.bridge.saveSubagentDefaults.mockRejectedValueOnce(new Error('写入失败'))
  act(() => context.settings().saveSubagentDefaults({ thinkingLevel: 'low' }))
  await waitFor(() => expect(context.settings().subagentStatus.thinkingLevel).toContain('写入失败'))
  expect(context.settings().subagentDefaults.thinkingLevel).toBeNull()
  act(() => {
    context.settings().saveSubagentDefaults({ thinkingLevel: 'low' })
    context.settings().saveSubagentDefaults({ model: { provider: 'test', id: 'selected' } })
  })
  await waitFor(() => expect(context.settings().subagentPending).toEqual({}))
  expect(context.settings().subagentDefaults).toEqual({
    model: { provider: 'test', id: 'selected' },
    thinkingLevel: 'low',
  })
  expect(context.bridge.saveSettings).not.toHaveBeenCalled()
})
