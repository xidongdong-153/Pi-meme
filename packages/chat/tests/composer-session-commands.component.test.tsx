import assert from 'node:assert/strict'
import { useState } from 'react'
import { afterEach, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ChatBridge, Snapshot } from '@pi-meme/contracts/desktop'
import { builtinCommands } from '@pi-meme/contracts/pi'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Composer, type ComposerProps } from '../src/ui/composer/composer'
import { setEditorCaret } from '../src/ui/composer/rich-draft'
import { useChatSession } from '../src/ui/use-chat-session'

afterEach(cleanup)

const snapshot = {
  connection: { generation: 1, cwd: '/tmp', sessionKey: 'session', status: 'ready' },
  state: {
    mode: 'default',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    pendingMessageCount: 0,
  },
  models: [],
  messages: [],
} as Snapshot
const startedSnapshot = {
  ...snapshot,
  messages: [{ role: 'user', content: '已有对话', timestamp: 1 }],
} as Snapshot

function sessionFixture(options?: { canSend?: () => boolean; streaming?: boolean; empty?: boolean }) {
  const prompt = vi.fn(async () => {})
  const errors: string[] = []
  const failed: string[] = []
  const result = renderHook(() =>
    useChatSession({
      bridge: {
        prompt,
        setSessionMode: async () => {},
        clearQueue: async () => ({ steering: [], followUp: [] }),
      } as unknown as ChatBridge,
      commands: builtinCommands,
      canSend: options?.canSend ?? (() => true),
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'session',
      onError: (message) => errors.push(message),
      onSendFailed: (_key, composer) => failed.push(composer.draft),
    }),
  ).result
  act(() => {
    const source = options?.empty ? snapshot : startedSnapshot
    result.current.loadSnapshot(
      options?.streaming ? { ...source, state: { ...source.state, isStreaming: true } } : source,
      null,
    )
    result.current.setDraft('保留草稿')
  })
  return { result, prompt, errors, failed }
}

test('点选压缩不改草稿，运行中或模型不可用时不发送', async () => {
  const ready = sessionFixture()
  await act(async () => {
    await ready.result.current.compactNow()
  })
  assert.deepEqual(ready.prompt.mock.calls[0], ['session', '/compact', [], [], { mode: 'default' }])
  assert.equal(ready.result.current.draft, '保留草稿')

  act(() => {
    ready.result.current.clearPromptPending()
    ready.result.current.loadSnapshot(startedSnapshot, null)
  })
  ready.prompt.mockRejectedValueOnce(new Error('压缩失败'))
  await act(async () => {
    await ready.result.current.compactNow()
  })
  assert.equal(ready.result.current.draft, '保留草稿')
  assert.equal(ready.result.current.chat.running, false)
  assert.equal(ready.errors.at(-1), 'Error: 压缩失败')
  assert.deepEqual(ready.failed, ['保留草稿'])

  const running = sessionFixture({ streaming: true })
  await act(async () => {
    await running.result.current.compactNow()
  })
  assert.equal(running.prompt.mock.calls.length, 0)
  assert.equal(running.errors.at(-1), 'Pi 正在运行或切换，请等待完成后重试')
  assert.equal(running.result.current.draft, '保留草稿')

  const unavailable = sessionFixture({ canSend: () => false })
  await act(async () => {
    await unavailable.result.current.compactNow()
  })
  assert.equal(unavailable.prompt.mock.calls.length, 0)
  assert.equal(unavailable.errors.at(-1), '当前模型已不可用，请先重新选择模型')
})

function composerFixture(options?: { sessionStarted?: boolean; running?: boolean }) {
  const compacted = vi.fn()
  const renamed = vi.fn(async () => {})
  const sent = vi.fn()
  const errors: string[] = []
  let draft = ''
  let updateDraft!: (value: string) => void
  function Page({ sessionName = '当前标题' }: { sessionName?: string }) {
    const [value, setValue] = useState('')
    draft = value
    updateDraft = setValue
    const props: ComposerProps = {
      sessionKey: 'session',
      sessionName,
      sessionStarted: options?.sessionStarted,
      draft: value,
      onDraft: setValue,
      onCompact: compacted,
      onRenameSession: renamed,
      selectedSkills: [],
      onSkills: () => {},
      attachments: [],
      uploadAttachment: async () => ({ name: 'file', path: '/attachments/file' }),
      onAddImages: () => {},
      onRemoveImage: () => {},
      running: options?.running ?? false,
      disabled: false,
      queueMode: 'followUp',
      onQueueMode: () => {},
      onSteeringMode: () => {},
      onFollowUpMode: () => {},
      queues: { steering: [], followUp: [] },
      onSend: sent,
      onStop: () => {},
      onClearQueue: () => {},
      commands: builtinCommands,
      widgetsAbove: null,
      widgetsBelow: null,
      statusBadges: null,
      focusVersion: 0,
      onError: (message) => errors.push(message),
      model: null,
      access: null,
      contextUsage: null,
      editing: false,
      onCancelEdit: () => {},
    }
    return (
      <TooltipProvider>
        <Composer {...props} />
      </TooltipProvider>
    )
  }
  const view = render(<Page />)
  const editor = screen.getByRole('combobox', { name: '消息' })
  function input(text: string) {
    act(() => updateDraft(text))
    editor.focus()
    setEditorCaret(editor, text.length)
    fireEvent.input(editor)
  }
  return {
    view,
    editor,
    input,
    compacted,
    renamed,
    sent,
    errors,
    draft: () => draft,
    rerender: (sessionName?: string) => view.rerender(<Page sessionName={sessionName} />),
  }
}

test('斜杠菜单里压缩立即执行，命名打开预填面板且不改草稿', async () => {
  const page = composerFixture()
  page.input('/')
  const options = screen.getAllByRole('option')
  assert.match(options[2]?.textContent ?? '', /压缩/)
  assert.match(options[2]?.textContent ?? '', /立即压缩当前会话上下文/)
  assert.match(options[3]?.textContent ?? '', /命名/)
  assert.match(options[3]?.textContent ?? '', /重命名当前会话/)
  assert.doesNotMatch(options[3]?.textContent ?? '', /\/name/)

  page.input('/c')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  assert.equal(page.compacted.mock.calls.length, 1)
  assert.equal(page.sent.mock.calls.length, 0)
  assert.equal(page.draft(), '/c')
  assert.equal(screen.queryByRole('listbox'), null)

  page.input('/n')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  const dialog = screen.getByRole('dialog', { name: '重命名会话' })
  const name = screen.getByRole('textbox', { name: '会话名称' })
  assert.equal((name as HTMLInputElement).value, '当前标题')
  assert.equal(page.draft(), '/n')

  fireEvent.change(name, { target: { value: '   ' } })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  assert.equal(screen.getByRole('alert').textContent, '会话名称不能为空')
  assert.equal(page.renamed.mock.calls.length, 0)
  assert.equal(dialog.isConnected, true)

  fireEvent.change(name, { target: { value: '当前标题' } })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  assert.equal(page.renamed.mock.calls.length, 0)
  assert.equal(screen.queryByRole('dialog', { name: '重命名会话' }), null)

  page.input('/n')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  fireEvent.keyDown(screen.getByRole('textbox', { name: '会话名称' }), { key: 'Escape' })
  assert.equal(screen.queryByRole('dialog', { name: '重命名会话' }), null)
  assert.equal(page.renamed.mock.calls.length, 0)

  page.input('/n')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  assert.equal(screen.queryByRole('dialog', { name: '重命名会话' }), null)

  page.input('/n')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  fireEvent.change(screen.getByRole('textbox', { name: '会话名称' }), { target: { value: '新会话' } })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  await waitFor(() => assert.deepEqual(page.renamed.mock.calls[0], ['新会话']))
  assert.equal(page.draft(), '/n')
  assert.equal(screen.queryByRole('dialog', { name: '重命名会话' }), null)

  page.renamed.mockRejectedValueOnce(new Error('请先停止任务'))
  page.input('/n')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  fireEvent.change(screen.getByRole('textbox', { name: '会话名称' }), { target: { value: '另一个名称' } })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  await waitFor(() => assert.equal(screen.getByRole('alert').textContent, '请先停止任务'))
  assert.equal(screen.getByRole('dialog', { name: '重命名会话' }).isConnected, true)
  assert.equal(page.draft(), '/n')

  page.input('/')
  assert.equal(screen.queryByRole('dialog', { name: '重命名会话' }), null)
  assert.ok(screen.getByRole('listbox'))
})

test('新会话不提供压缩和命名，手打命令也不会发送', async () => {
  const page = composerFixture({ sessionStarted: false })
  page.input('/')
  const labels = screen
    .getAllByRole('option')
    .map((item) => item.textContent ?? '')
    .join('\n')
  assert.match(labels, /计划/)
  assert.match(labels, /目标/)
  assert.doesNotMatch(labels, /压缩|命名/)
  page.input('/compact')
  assert.equal(screen.queryByRole('option', { name: /压缩/ }), null)

  const empty = sessionFixture({ empty: true })
  await act(async () => {
    await empty.result.current.compactNow()
  })
  assert.equal(empty.prompt.mock.calls.length, 0)
  assert.equal(empty.errors.at(-1), '当前还是新会话，开始对话后才能压缩')
  assert.equal(empty.result.current.draft, '保留草稿')

  act(() => empty.result.current.setDraft('/name 新标题'))
  await act(async () => {
    await empty.result.current.send()
  })
  assert.equal(empty.prompt.mock.calls.length, 0)
  assert.equal(empty.result.current.draft, '/name 新标题')
  assert.equal(empty.errors.at(-1), '当前还是新会话，开始对话后才能重命名')
})

test('已开始但正在运行时，命名不打开面板', () => {
  const page = composerFixture({ sessionStarted: true, running: true })
  page.input('/n')
  fireEvent.keyDown(page.editor, { key: 'Enter', nativeEvent: {} })
  assert.equal(screen.queryByRole('dialog', { name: '重命名会话' }), null)
  assert.equal(page.errors.at(-1), 'Pi 正在运行或切换，请等待完成后重试')
  assert.equal(page.draft(), '/n')
  assert.equal(page.renamed.mock.calls.length, 0)
})
