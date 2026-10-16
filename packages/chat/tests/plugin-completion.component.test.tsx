import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import { useChatSession } from '../src/ui/use-chat-session'
import { builtinCommands, type PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Composer, type AgentPluginOption, type ComposerProps } from '../src/ui/composer/composer'
import { readEditorText, setEditorCaret } from '../src/ui/composer/rich-draft'
import { movePluginPositions } from '../src/ui/composer/editor-plugin-tokens'

afterEach(cleanup)

const cloud: AgentPluginOption = {
  id: 'cloud',
  name: 'Cloud Environment',
  description: '读取云环境配置',
  iconUrl: '/cloud.png',
}
const skill: PiSlashCommand = {
  ...builtinCommands[0],
  source: 'skill',
  name: 'skill:review',
  displayName: 'Review',
  description: '检查代码',
  resourceId: 'review-id',
  resourceRevision: 'r1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function setup(initialPlugins: AgentPluginOption[] = []) {
  const save = vi.fn(async (_ids: string[]) => true)
  const sent = vi.fn()
  let state!: { draft: string; plugins: AgentPluginOption[]; skills: PiSlashCommand[]; saving: boolean }
  let updateDraft!: (value: string) => void
  let updateBusy!: (value: boolean) => void
  let switchSession!: (key: string, plugins: AgentPluginOption[]) => void
  function Page() {
    const [draft, setDraft] = useState('')
    const [plugins, setPlugins] = useState(initialPlugins)
    const [mentions, setMentions] = useState(initialPlugins)
    const [skills, setSkills] = useState<PiSlashCommand[]>([])
    const [saving, setSaving] = useState(false)
    const [busy, setBusy] = useState(false)
    const [sessionKey, setSessionKey] = useState('a')
    state = { draft, plugins, skills, saving }
    updateDraft = setDraft
    updateBusy = setBusy
    switchSession = (key, next) => {
      setSessionKey(key)
      setPlugins(next)
      setMentions([])
      setSkills([])
      setDraft('')
    }
    const change = async (ids: string[]) => {
      if (busy || saving) return false
      setSaving(true)
      try {
        const success = await save(ids)
        if (success) {
          setPlugins(ids.map(() => cloud))
          setMentions((value) => value.filter((plugin) => ids.includes(plugin.id)))
        }
        return success
      } finally {
        setSaving(false)
      }
    }
    const props: ComposerProps = {
      sessionKey,
      draft,
      onDraft: setDraft,
      selectedSkills: skills,
      onSkills: setSkills,
      agentPlugins: {
        options: [cloud],
        selected: plugins,
        mentions,
        loading: false,
        saving,
        disabledReason: saving ? '正在保存插件选择' : busy ? '任务结束后可修改插件' : undefined,
        change,
        select: async (id) => {
          const success =
            plugins.some((plugin) => plugin.id === id) || (await change([...plugins.map((plugin) => plugin.id), id]))
          if (success) setMentions((value) => (value.some((plugin) => plugin.id === id) ? value : [...value, cloud]))
          return success
        },
      },
      attachments: [],
      onAddImages: () => {},
      onRemoveImage: () => {},
      running: busy,
      disabled: false,
      queueMode: 'followUp',
      onQueueMode: () => {},
      onSteeringMode: () => {},
      onFollowUpMode: () => {},
      queues: { steering: [], followUp: [] },
      onSend: () => {
        sent({ draft, skills })
        setDraft('')
        setSkills([])
        setMentions([])
      },
      onStop: () => {},
      onClearQueue: () => {},
      commands: [...builtinCommands, skill],
      widgetsAbove: null,
      widgetsBelow: null,
      statusBadges: null,
      focusVersion: 0,
      onError: () => {},
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
    ...view,
    editor,
    save,
    sent,
    input,
    state: () => state,
    busy: (value: boolean) => act(() => updateBusy(value)),
    switchSession: (key: string, plugins: AgentPluginOption[]) => act(() => switchSession(key, plugins)),
  }
}

test('/ 按命令、技能、插件排列，$ 仅技能；两类资源都插入行内节点', async () => {
  const f = setup()
  f.input('/')
  const options = screen.getAllByRole('option')
  expect(options.map((item) => item.textContent)).toEqual([
    expect.stringContaining('/plan'),
    expect.stringContaining('/compact'),
    expect.stringContaining('/name'),
    expect.stringContaining('Review'),
    expect.stringContaining('Cloud Environment'),
  ])
  expect(screen.queryByText('已启用')).toBeNull()
  fireEvent.click(options[4])
  await waitFor(() => expect(f.editor.querySelector('[data-plugin-token="cloud"]')).not.toBeNull())
  expect(f.state().draft).toBe('')
  expect(readEditorText(f.editor)).toBe('')
  expect(f.editor.querySelector('img')?.getAttribute('src')).toBe('/cloud.png')
  f.input('$')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.queryByRole('group', { name: '插件' })).toBeNull()
  f.input('/Review')
  fireEvent.keyDown(f.editor, { key: 'Enter' })
  expect(f.state().skills).toEqual([skill])
  expect(f.state().draft).toBe(`${skillMarker} `)
  expect(f.editor.querySelectorAll('[data-skill-token]')).toHaveLength(1)
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(1)
  expect(readEditorText(f.editor)).toBe(`${skillMarker} `)
})

test('保存期间仍可编辑正文但不能发送，成功才显示插件；发送后清空引用但保留会话配置', async () => {
  const f = setup()
  const pending = deferred<boolean>()
  f.save.mockImplementationOnce(() => pending.promise)
  f.input('/云环境')
  fireEvent.keyDown(f.editor, { key: 'Tab' })
  expect(f.state().saving).toBe(true)
  expect(f.editor.querySelector('[data-plugin-token]')).toBeNull()
  f.input('继续输入正文')
  expect(f.editor.contentEditable).not.toBe('false')
  expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.submit(screen.getByRole('form', { name: '消息输入' }))
  expect(f.sent).not.toHaveBeenCalled()
  await act(async () => {
    pending.resolve(true)
  })
  await waitFor(() => expect(f.state().saving).toBe(false))
  expect(f.state().draft).toBe('继续输入正文')
  expect(readEditorText(f.editor)).toBe('继续输入正文')
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(1)
  fireEvent.submit(screen.getByRole('form', { name: '消息输入' }))
  expect(f.sent).toHaveBeenCalledWith({ draft: '继续输入正文', skills: [] })
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(0)
  expect(f.state().plugins).toEqual([cloud])
  expect(readEditorText(f.editor)).toBe('')
  fireEvent.submit(screen.getByRole('form', { name: '消息输入' }))
  expect(f.sent).toHaveBeenCalledTimes(1)
  f.input('下一轮直接提问')
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(0)
  fireEvent.submit(screen.getByRole('form', { name: '消息输入' }))
  expect(f.state().plugins).toEqual([cloud])
  expect(f.save).toHaveBeenCalledTimes(1)
  f.input('/Cloud')
  fireEvent.keyDown(f.editor, { key: 'Enter' })
  await waitFor(() => expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(1))
  expect(f.save).toHaveBeenCalledTimes(1)
})

test('重复选择不重复插入，退格删除引用才移除会话插件，失败时引用和正文保留', async () => {
  const f = setup([cloud])
  f.input('/Cloud')
  fireEvent.keyDown(f.editor, { key: 'Enter' })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(1)
  f.input('保留正文')
  setEditorCaret(f.editor, 0)
  f.save.mockResolvedValueOnce(false)
  fireEvent.keyDown(f.editor, { key: 'Backspace' })
  await waitFor(() => expect(f.state().saving).toBe(false))
  expect(f.save).toHaveBeenLastCalledWith([])
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(1)
  expect(readEditorText(f.editor)).toBe('保留正文')
  setEditorCaret(f.editor, 0)
  fireEvent.keyDown(f.editor, { key: 'Backspace' })
  await waitFor(() => expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(0))
  expect(f.state().draft).toBe('保留正文')
})

test('原生编辑器尾部补 BR 且光标落在容器上时，退格仍删除完整插件引用', async () => {
  const f = setup([cloud])
  const token = f.editor.querySelector('[data-plugin-token]')!
  f.editor.replaceChildren(token, document.createElement('br'))
  const range = document.createRange()
  range.selectNodeContents(f.editor)
  range.collapse(false)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  fireEvent.keyDown(f.editor, { key: 'Backspace' })
  await waitFor(() => expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(0))
  expect(f.save).toHaveBeenLastCalledWith([])
  expect(f.state().draft).toBe('')
})

test('运行中保护插件引用，选区删除和切换会话不残留旧插件', async () => {
  const f = setup([cloud])
  f.input('正文')
  f.busy(true)
  setEditorCaret(f.editor, 0)
  fireEvent.keyDown(f.editor, { key: 'Backspace' })
  expect(f.save).not.toHaveBeenCalled()
  f.editor.querySelector('[data-plugin-token]')!.remove()
  fireEvent.input(f.editor)
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(1)
  f.busy(false)
  f.editor.querySelector('[data-plugin-token]')!.remove()
  fireEvent.input(f.editor)
  await waitFor(() => expect(f.state().plugins).toHaveLength(0))
  expect(f.save).toHaveBeenLastCalledWith([])
  expect(f.state().draft).toBe('正文')
  f.switchSession('b', [])
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(0)
  f.switchSession('a', [cloud])
  expect(f.editor.querySelectorAll('[data-plugin-token]')).toHaveLength(0)
  expect(f.state().plugins).toEqual([cloud])
})

test('正文替换只移动插件排版位置，不新增消息占位符', () => {
  const positions = new Map([
    ['first', 0],
    ['middle', 4],
    ['last', 8],
  ])
  movePluginPositions(positions, 'abcdefgh', 'abXYefgh')
  expect([...positions.values()]).toEqual([0, 4, 8])
  movePluginPositions(positions, 'abXYefgh', '')
  expect([...positions.values()]).toEqual([0, 0, 0])
})

function chatSession() {
  const prompt = vi.fn(async () => {})
  const followUp = vi.fn(async () => {})
  const onError = vi.fn()
  const onSendStarted = vi.fn(() => () => {})
  const onSendFailed = vi.fn()
  const bridge = { prompt, followUp } as unknown as ChatBridge
  const hook = renderHook(() =>
    useChatSession({
      bridge,
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'session',
      onError,
      onSendStarted,
      onSendFailed,
    }),
  )
  return { ...hook, prompt, followUp, onError, onSendStarted, onSendFailed }
}

test('真实发送生命周期清空插件草稿引用但不把它写进 prompt，下一轮不会重新出现', async () => {
  const f = chatSession()
  act(() => {
    f.result.current.setDraft('使用插件完成任务')
    f.result.current.setPluginMentions(['cloud'])
  })
  await act(async () => {
    await f.result.current.send()
  })
  expect(f.result.current.pluginMentions).toEqual([])
  expect(f.result.current.captureComposer().pluginMentions).toBeUndefined()
  expect(f.prompt).toHaveBeenCalledWith('session', '使用插件完成任务', [], [], { mode: 'default' })
  expect(f.onSendStarted.mock.calls[0]).toEqual(['session', expect.objectContaining({ pluginMentions: ['cloud'] })])
  act(() => {
    f.result.current.setDraft('后续直接继续任务')
  })
  await act(async () => {
    await f.result.current.send()
  })
  expect(f.result.current.pluginMentions).toEqual([])
  expect(f.followUp).toHaveBeenCalledWith('session', '后续直接继续任务', [], [], { mode: 'default' })
})

test('发送失败恢复插件引用，切换和恢复草稿只恢复待发送引用', async () => {
  const f = chatSession()
  f.prompt.mockRejectedValueOnce(new Error('发送失败'))
  act(() => {
    f.result.current.setDraft('正文')
    f.result.current.setPluginMentions(['cloud'])
  })
  await act(async () => {
    await f.result.current.send()
  })
  expect(f.result.current.draft).toBe('正文')
  expect(f.result.current.pluginMentions).toEqual(['cloud'])
  expect(f.onSendFailed.mock.calls[0]).toEqual(['session', expect.objectContaining({ pluginMentions: ['cloud'] })])
  const saved = f.result.current.captureComposer()
  act(() => {
    f.result.current.reset()
  })
  expect(f.result.current.pluginMentions).toEqual([])
  act(() => {
    f.result.current.restoreComposer(saved)
  })
  expect(f.result.current.pluginMentions).toEqual(['cloud'])
})
