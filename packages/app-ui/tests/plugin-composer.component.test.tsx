import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { ComposerEditor } from '@pi-meme/chat/ui/composer/composer-editor'
import type { ComposerDraftStore } from '@pi-meme/chat/ui/composer/composer-state'
import { editorSelection, setEditorSelection } from '@pi-meme/chat/ui/composer/rich-draft'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import type { RegisteredBeforeSendHook } from '@pi-meme/plugin-sdk/composer'
import { useChatSession } from '@pi-meme/chat/ui/use-chat-session'
import { usePluginComposerController, type PluginComposerOptions } from '../src/plugins/plugin-composer-adapter'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function fixture(
  hooks: RegisteredBeforeSendHook[] = [],
  session?: PluginComposerOptions['session'],
  commands: PiSlashCommand[] = [],
  policy: Pick<Partial<PluginComposerOptions>, 'requiredHooks' | 'canProcess' | 'authorizationRevision'> = {},
  awaitPendingSwitch: () => Promise<void> = async () => {},
) {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const editAndPrompt = vi.fn<ChatBridge['editAndPrompt']>().mockResolvedValue({ recoveredInputs: [] })
  const continueStopped = vi.fn<ChatBridge['continueStopped']>().mockResolvedValue(undefined)
  const bridge = {
    editAndPrompt,
    continueStopped,
    prompt,
    followUp: vi.fn().mockResolvedValue(undefined),
    uploadAttachment: vi.fn(),
  } as unknown as ChatBridge
  let props = {
    visible: true,
    session,
    hooks,
    requiredHooks: policy.requiredHooks,
    canProcess: policy.canProcess ?? (() => true),
    authorizationRevision: policy.authorizationRevision ?? 1,
  }
  const hook = renderHook(
    ({ visible, session, hooks, requiredHooks, canProcess, authorizationRevision }) => {
      const chat = useChatSession({
        bridge,
        commands,
        canSend: () => true,
        isSwitching: () => false,
        awaitPendingSwitch,
        currentGeneration: () => 1,
        currentSessionKey: () => 'runtime',
        onError: () => {},
      })
      const composer = usePluginComposerController({
        chat: {
          ...chat,
          connection: {
            generation: 1,
            sessionKey: 'runtime',
            cwd: '/project',
            status: 'idle',
            workspaceKind: 'project',
          },
          inputDisabled: false,
          loading: false,
          commands,
          setError: () => {},
        } as unknown as PluginComposerOptions['chat'],
        hostId: 'host',
        session,
        visible,
        hooks,
        requiredHooks,
        authorizationRevision,
        canProcess,
      })
      return { chat, composer }
    },
    { initialProps: props },
  )
  return {
    ...hook,
    prompt,
    editAndPrompt,
    continueStopped,
    rerender: (patch: Partial<typeof props>) => {
      props = { ...props, ...patch }
      hook.rerender(props)
    },
  }
}

test.each(['missing', 'old-generation', 'not-ready'] as const)(
  '已启用 required 处理器 %s 时不得静默当成零 hook 发送',
  async (state) => {
    const process = vi.fn(() => ({ kind: 'block' as const, reason: '检测到阻止标记' }))
    const hook = { id: 'validate', title: '校验', pluginId: 'plugin', generation: 2, process }
    const requiredHooks = [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }]
    const { result, prompt, rerender } = fixture(
      state === 'missing' ? [] : [{ ...hook, generation: state === 'old-generation' ? 1 : 2 }],
      undefined,
      [],
      { requiredHooks, canProcess: () => state !== 'not-ready' },
    )
    act(() => result.current.chat.setDraft('[阻止] 第一条草稿'))
    await act(async () => expect(await result.current.chat.submitComposer()).toBe(false))
    expect(prompt).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
    expect(result.current.chat.draft).toBe('[阻止] 第一条草稿')
    expect(result.current.composer.view?.canSubmit).toBe(false)
    expect(result.current.composer.availabilityReason).toContain('plugin/validate')
    const view = result.current.composer.view!
    await act(async () =>
      expect(await result.current.composer.adapter.submit(view.ref, { expectedRevision: view.revision })).toMatchObject(
        { status: 'blocked', reason: expect.stringContaining('plugin/validate') },
      ),
    )
    expect(prompt).not.toHaveBeenCalled()
    await act(async () => rerender({ hooks: [hook], canProcess: () => true }))
    expect(result.current.composer.availabilityReason).toBeUndefined()
    await act(async () => expect(await result.current.chat.submitComposer()).toBe(false))
    expect(process).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()
    expect(result.current.chat.draft).toBe('[阻止] 第一条草稿')
    expect(result.current.composer.view?.failure?.reason).toBe('检测到阻止标记')
  },
)

test('hook 同代码新授权代次就绪时首条经过处理，旧任务代次不要求匹配 UI 代次', async () => {
  const process = vi.fn(() => ({
    kind: 'replace' as const,
    input: { document: [{ kind: 'text' as const, text: '首条已校验' }], attachmentIds: [] },
  }))
  const hook = { id: 'validate', title: '校验', pluginId: 'plugin', generation: 2, process }
  const { result, prompt, rerender } = fixture([hook], undefined, [], {
    requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }],
    canProcess: () => false,
  })
  act(() => result.current.chat.setDraft('首条草稿'))
  await act(async () => rerender({ canProcess: () => true, authorizationRevision: 2 }))
  await act(async () => expect(await result.current.chat.submitComposer()).toBe(true))
  expect(process).toHaveBeenCalledTimes(1)
  expect(prompt.mock.calls[0]?.[1]).toBe('首条已校验')
})

test('显式关闭 required 且处理器不再 eligible 后允许普通发送', async () => {
  const process = vi.fn(() => ({ kind: 'block' as const, reason: '不应调用已关闭的处理器' }))
  const { result, prompt, rerender } = fixture(
    [{ id: 'validate', title: '校验', pluginId: 'plugin', generation: 2, process }],
    undefined,
    [],
    { requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }], canProcess: () => false },
  )
  act(() => result.current.chat.setDraft('显式关闭校验后的普通草稿'))
  expect(result.current.composer.view?.canSubmit).toBe(false)
  await act(async () => rerender({ requiredHooks: [] }))
  await act(async () => expect(await result.current.chat.submitComposer()).toBe(true))
  expect(process).not.toHaveBeenCalled()
  expect(prompt).toHaveBeenCalledTimes(1)
})

test('只改变 required 清单也取消等待中的旧处理，迟到 pass 不能发稿', async () => {
  let resolve!: (value: { kind: 'pass' }) => void
  let signal!: AbortSignal
  const process = vi.fn((input: Parameters<RegisteredBeforeSendHook['process']>[0]) => {
    signal = input.signal
    return new Promise<{ kind: 'pass' }>((done) => {
      resolve = done
    })
  })
  const { result, prompt, rerender } = fixture(
    [{ id: 'validate', title: '校验', pluginId: 'plugin', generation: 2, process }],
    undefined,
    [],
    { requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }] },
  )
  act(() => result.current.chat.setDraft('等待期间保持原稿'))
  let sending!: Promise<boolean>
  await act(async () => {
    sending = result.current.chat.submitComposer()
    await Promise.resolve()
  })
  expect(process).toHaveBeenCalledTimes(1)
  await act(async () => rerender({ requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 3 }] }))
  expect(signal.aborted).toBe(true)
  await act(async () => {
    resolve({ kind: 'pass' })
    expect(await sending).toBe(false)
  })
  expect(prompt).not.toHaveBeenCalled()
  expect(result.current.chat.draft).toBe('等待期间保持原稿')
  expect(result.current.composer.availabilityReason).toContain('代次 3')
})

test('hook await 后 required 变为不可用时复核并保留草稿', async () => {
  let ready = true
  const process = vi.fn(async () => {
    await Promise.resolve()
    ready = false
    return { kind: 'pass' as const }
  })
  const { result, prompt } = fixture(
    [{ id: 'validate', title: '校验', pluginId: 'plugin', generation: 2, process }],
    undefined,
    [],
    { requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }], canProcess: () => ready },
  )
  act(() => result.current.chat.setDraft('不得在授权变化后发出'))
  await act(async () => expect(await result.current.chat.submitComposer()).toBe(false))
  expect(process).toHaveBeenCalledTimes(1)
  expect(prompt).not.toHaveBeenCalled()
  expect(result.current.chat.draft).toBe('不得在授权变化后发出')
  expect(result.current.composer.availabilityReason).toContain('当前不可用')
})

test('零 records 候选等待 switch 时启用已就绪 required，不发送旧候选且下次才执行处理', async () => {
  let releaseSwitch!: () => void
  let enteredSwitch!: () => void
  const switching = new Promise<void>((done) => {
    releaseSwitch = done
  })
  const entered = new Promise<void>((done) => {
    enteredSwitch = done
  })
  const waitSwitch = vi.fn(() => {
    enteredSwitch()
    return switching
  })
  const process = vi.fn(() => ({
    kind: 'replace' as const,
    input: { document: [{ kind: 'text' as const, text: '新策略处理后的稿件' }], attachmentIds: [] },
  }))
  const { result, prompt, rerender } = fixture([], undefined, [], {}, waitSwitch)
  act(() => result.current.chat.setDraft('旧的零处理器候选'))
  let sending!: Promise<boolean>
  await act(async () => {
    sending = result.current.chat.submitComposer()
    await entered
  })
  expect(waitSwitch).toHaveBeenCalledTimes(1)
  expect(prompt).not.toHaveBeenCalled()
  await act(async () =>
    rerender({
      hooks: [{ id: 'validate', title: '校验', pluginId: 'plugin', generation: 2, process }],
      requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }],
      canProcess: () => true,
    }),
  )
  expect(result.current.composer.availabilityReason).toBeUndefined()
  expect(result.current.composer.view?.canSubmit).toBe(true)
  await act(async () => {
    releaseSwitch()
    expect(await sending).toBe(false)
  })
  expect(prompt).not.toHaveBeenCalled()
  expect(result.current.chat.draft).toBe('旧的零处理器候选')
  expect(process).not.toHaveBeenCalled()
  await act(async () => expect(await result.current.chat.submitComposer()).toBe(true))
  expect(process).toHaveBeenCalledTimes(1)
  expect(prompt.mock.calls[0]?.[1]).toBe('新策略处理后的稿件')
})

test.each(['draft', 'target', 'policy'] as const)(
  '失败 attempt 的确认 signal 在 %s 变化时取消，错 id 不返回',
  async (change) => {
    const { result, rerender, prompt } = fixture(
      [
        {
          id: 'validate',
          title: '校验',
          pluginId: 'plugin',
          generation: 2,
          process: () => ({ kind: 'block', reason: '等待确认' }),
        },
      ],
      undefined,
      [],
      { requiredHooks: [{ pluginId: 'plugin', hookId: 'validate', generation: 2 }] },
    )
    act(() => result.current.chat.setDraft('保留失败草稿'))
    await act(async () => expect(await result.current.chat.submitComposer()).toBe(false))
    const id = result.current.composer.view!.failure!.attemptId
    const signal = result.current.composer.getFailureSignal(id)!
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(result.current.composer.getFailureSignal('wrong-id')).toBeUndefined()
    await act(async () => {
      if (change === 'draft') result.current.chat.setDraft('新草稿')
      else if (change === 'target')
        rerender({ session: { hostId: 'host', sessionId: 'new-target' } as PluginComposerOptions['session'] })
      else rerender({ authorizationRevision: 2 })
    })
    expect(signal.aborted).toBe(true)
    expect(result.current.composer.getFailureSignal(id)).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()
  },
)

test('尚无稳定 SessionRef 的草稿可读取，snapshot稳定且读取不创建或发送会话', () => {
  const { result, prompt } = fixture()
  act(() => result.current.chat.setDraft('尚未绑定会话的真实草稿'))
  const view = result.current.composer.view!
  expect(view.ref.session).toBeUndefined()
  expect(view.ref.target.kind).toBe('project-draft')
  expect(result.current.composer.adapter.current()).toBe(view)
  expect(result.current.composer.adapter.getSnapshot(view.ref)).toBe(view)
  expect(view.document).toEqual([{ kind: 'text', text: '尚未绑定会话的真实草稿' }])
  expect(prompt).not.toHaveBeenCalled()
})

test('进入插件页使旧epoch失效，返回聊天不清草稿也不复活旧引用', async () => {
  const { result, rerender } = fixture()
  act(() => result.current.chat.setDraft('保留这份草稿'))
  const previous = result.current.composer.view!
  await act(async () => rerender({ visible: false }))
  expect(result.current.composer.adapter.current()).toBeNull()
  expect(result.current.composer.adapter.getSnapshot(previous.ref)).toBeNull()
  await act(async () => rerender({ visible: true }))
  expect(result.current.composer.view!.ref.epoch).toBeGreaterThan(previous.ref.epoch)
  expect(result.current.composer.adapter.getSnapshot(previous.ref)).toBeNull()
  expect(result.current.chat.draft).toBe('保留这份草稿')
})

test('SDK事务统一CAS与IME守卫，组合输入结束后才允许改写', () => {
  const { result } = fixture()
  act(() => result.current.chat.setDraft('原稿'))
  const previous = result.current.composer.view!
  act(() => result.current.chat.composerStore.setComposing(true))
  expect(
    result.current.composer.adapter.apply(previous.ref, {
      expectedRevision: previous.revision,
      steps: [{ kind: 'replace', from: 0, to: 2, content: [{ kind: 'text', text: 'SDK' }] }],
    }),
  ).toMatchObject({ status: 'rejected', code: 'composition-active' })
  act(() => {
    result.current.chat.composerStore.setComposing(false)
    result.current.chat.setDraft('用户新稿')
  })
  expect(
    result.current.composer.adapter.apply(previous.ref, { expectedRevision: previous.revision, steps: [] }),
  ).toMatchObject({ status: 'rejected', code: 'stale-draft' })
  const current = result.current.composer.view!
  act(() => {
    expect(
      result.current.composer.adapter.apply(current.ref, {
        expectedRevision: current.revision,
        steps: [{ kind: 'replace', from: 0, to: 4, content: [{ kind: 'text', text: '已授权修改' }] }],
      }),
    ).toMatchObject({ status: 'applied' })
  })
  expect(result.current.chat.draft).toBe('已授权修改')
})

test('真实adapter准备期间继续输入取消hook，晚结果不能发旧稿', async () => {
  let resolve!: (value: { kind: 'pass' }) => void
  const process = vi.fn(
    () =>
      new Promise<{ kind: 'pass' }>((done) => {
        resolve = done
      }),
  )
  const { result, prompt } = fixture([{ id: 'slow', title: '慢处理', pluginId: 'plugin', generation: 1, process }])
  act(() => result.current.chat.setDraft('旧稿'))
  let sending!: Promise<boolean>
  await act(async () => {
    sending = result.current.chat.submitComposer()
    await Promise.resolve()
  })
  expect(process).toHaveBeenCalledTimes(1)
  act(() => result.current.chat.setDraft('处理中继续输入'))
  await act(async () => {
    resolve({ kind: 'pass' })
    expect(await sending).toBe(false)
  })
  expect(prompt).not.toHaveBeenCalled()
  expect(result.current.chat.draft).toBe('处理中继续输入')
})

test('失败处理器仅本次跳过后按原发送分支投递并携带无正文审计', async () => {
  const { result, prompt } = fixture([
    {
      id: 'validate',
      title: '校验',
      pluginId: 'plugin',
      generation: 3,
      process: () => {
        throw new Error('暂时不可用')
      },
    },
  ])
  act(() => result.current.chat.setDraft('待发送正文'))
  await act(async () => {
    expect(await result.current.chat.submitComposer()).toBe(false)
  })
  expect(result.current.composer.view?.failure?.hookId).toBe('validate')
  expect(result.current.chat.draft).toBe('待发送正文')
  await act(async () => {
    await result.current.composer.skip()
  })
  expect(prompt).toHaveBeenCalledTimes(1)
  const options = prompt.mock.calls[0]![4]
  expect(options.clientProcessingAudit).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ hookId: 'validate', outcome: 'skipped', userConfirmedAt: expect.any(String) }),
    ]),
  )
  expect(JSON.stringify(options.clientProcessingAudit)).not.toContain('待发送正文')
})

function EditorBinding({
  store,
  sessionKey = 'runtime',
  commands = [],
}: {
  store: ComposerDraftStore
  sessionKey?: string
  commands?: PiSlashCommand[]
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <ComposerEditor
      composerStore={store}
      sessionKey={sessionKey}
      draft={state.draft}
      selectedSkills={state.selectedSkills}
      onDraft={store.setDraft}
      onSkills={store.setSelectedSkills}
      commands={commands}
      hasQueue={false}
      focusVersion={0}
      onClearQueue={() => {}}
      paste={() => {}}
      dragging={false}
    />
  )
}

test('SDK 改稿交给原生编辑 binding，普通输入不重建 DOM，目标切换隔离 editable 节点', () => {
  const { result } = fixture()
  act(() => result.current.chat.setDraft('undo-check'))
  const store = result.current.chat.composerStore
  const screen = render(<EditorBinding store={store} />)
  const editor = screen.getByRole('combobox')
  editor.focus()
  setEditorSelection(editor, { anchor: 8, focus: 2 })
  const originalText = editor.firstChild
  const replace = vi.spyOn(editor, 'replaceChildren')
  // jsdom 只模拟命令产生的 DOM，断言 binding 路径；不把它当成原生 undo/redo 证据。
  const execute = vi.fn((command: string, _ui: boolean, value: string) => {
    const range = window.getSelection()!.getRangeAt(0)
    range.deleteContents()
    range.insertNode(document.createTextNode(value))
    fireEvent.input(editor)
    return command === 'insertText'
  })
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execute })
  try {
    const view = result.current.composer.view!
    act(() => {
      expect(
        result.current.composer.adapter.apply(view.ref, {
          expectedRevision: view.revision,
          steps: [{ kind: 'replace', from: 10, to: 10, content: [{ kind: 'text', text: '\nSDK' }] }],
        }),
      ).toMatchObject({ status: 'applied' })
    })
    expect(execute).toHaveBeenCalledWith('insertText', false, '\nSDK')
    expect(replace).not.toHaveBeenCalled()
    expect(editor.firstChild).toBe(originalText)
    expect(editorSelection(editor)).toEqual({ anchor: 8, focus: 2 })
    expect(store.getSnapshot().revision).toBe(view.revision + 1)
    const current = editor.lastChild!
    current.textContent += '!'
    act(() => fireEvent.input(editor))
    expect(replace).not.toHaveBeenCalled()
    expect(store.getSnapshot().draft).toBe('undo-check\nSDK!')
    screen.rerender(<EditorBinding store={store} sessionKey="other-target" />)
    expect(screen.getByRole('combobox')).not.toBe(editor)
  } finally {
    if (previous) Object.defineProperty(document, 'execCommand', previous)
    else Reflect.deleteProperty(document, 'execCommand')
  }
})

test('原生 binding 保留按钮焦点，命令失败或 IME/CAS 拒绝时不提交草稿', () => {
  const { result } = fixture()
  act(() => result.current.chat.setDraft('abcdef'))
  const store = result.current.chat.composerStore
  const screen = render(
    <>
      <button type="button">插件按钮</button>
      <EditorBinding store={store} />
    </>,
  )
  const editor = screen.getByRole('combobox')
  const button = screen.getByRole('button')
  editor.focus()
  setEditorSelection(editor, { anchor: 5, focus: 1 })
  fireEvent.mouseUp(editor)
  button.focus()
  const execute = vi.fn(() => false)
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execute })
  const view = result.current.composer.view!
  const input = {
    expectedRevision: view.revision,
    steps: [{ kind: 'replace' as const, from: 6, to: 6, content: [{ kind: 'text' as const, text: 'SDK' }] }],
  }
  try {
    act(() => expect(result.current.composer.adapter.apply(view.ref, input)).toMatchObject({ status: 'rejected' }))
    expect(store.getSnapshot().draft).toBe('abcdef')
    expect(store.getSnapshot().revision).toBe(view.revision)
    expect(document.activeElement).toBe(button)
    expect(store.getSnapshot().selection).toMatchObject({ anchor: 5, focus: 1 })
    act(() => store.setComposing(true))
    expect(result.current.composer.adapter.apply(view.ref, input)).toMatchObject({ code: 'composition-active' })
    act(() => {
      store.setComposing(false)
      store.setDraft('新稿')
    })
    expect(result.current.composer.adapter.apply(view.ref, input)).toMatchObject({ code: 'stale-draft' })
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    if (previous) Object.defineProperty(document, 'execCommand', previous)
    else Reflect.deleteProperty(document, 'execCommand')
  }
})

test('原子技能通过单次 HTML 编辑命令插入，回放旧 DOM 时从资源目录恢复技能', () => {
  const skill: PiSlashCommand = {
    name: 'skill:review',
    source: 'skill',
    resourceId: 'review',
    resourceRevision: 'r1',
    sourceInfo: { path: '/skills/review/SKILL.md', source: 'host', scope: 'user', origin: 'top-level' },
  }
  const { result } = fixture([], undefined, [skill])
  act(() => result.current.chat.setDraft('ab'))
  const store = result.current.chat.composerStore
  const screen = render(<EditorBinding store={store} commands={[skill]} />)
  const editor = screen.getByRole('combobox')
  const replace = vi.spyOn(editor, 'replaceChildren')
  const execute = vi.fn((command: string, _ui: boolean, value: string) => {
    const range = window.getSelection()!.getRangeAt(0)
    range.deleteContents()
    range.insertNode(command === 'insertHTML' ? range.createContextualFragment(value) : document.createTextNode(value))
    fireEvent.input(editor)
    return true
  })
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execute })
  try {
    let view = result.current.composer.view!
    act(() =>
      expect(
        result.current.composer.adapter.apply(view.ref, {
          expectedRevision: view.revision,
          steps: [
            {
              kind: 'replace',
              from: 1,
              to: 1,
              content: [{ kind: 'skill', id: 'review', revision: 'r1', name: 'skill:review' }],
            },
          ],
        }),
      ).toMatchObject({ status: 'applied' }),
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toBe('insertHTML')
    expect(editor.querySelector('[data-skill-token]')?.getAttribute('contenteditable')).toBe('false')
    expect(store.getSnapshot().draft).toBe(`a${skillMarker}b`)
    const previousHtml = editor.innerHTML
    view = result.current.composer.view!
    act(() =>
      expect(
        result.current.composer.adapter.apply(view.ref, {
          expectedRevision: view.revision,
          steps: [{ kind: 'replace', from: 1, to: 2, content: [] }],
        }),
      ).toMatchObject({ status: 'applied' }),
    )
    expect(store.getSnapshot().selectedSkills).toEqual([])
    // 只验证浏览器历史回放后的 input 同步，不在 jsdom 模拟或声称存在原生历史栈。
    editor.innerHTML = previousHtml
    act(() => fireEvent.input(editor))
    expect(store.getSnapshot().selectedSkills).toEqual([skill])
    expect(replace).not.toHaveBeenCalled()
    editor.innerHTML = 'a<div>bc<span contenteditable="false" data-plugin-token="plugin">插件</span>d</div>'
    setEditorSelection(editor, { anchor: 6, focus: 2 })
    expect(editorSelection(editor)).toEqual({ anchor: 6, focus: 2 })
    editor.innerHTML = 'a<div><br></div><div>bc</div>'
    setEditorSelection(editor, { anchor: 4, focus: 2 })
    expect(editorSelection(editor)).toEqual({ anchor: 4, focus: 2 })
  } finally {
    if (previous) Object.defineProperty(document, 'execCommand', previous)
    else Reflect.deleteProperty(document, 'execCommand')
  }
})

test('公开 ComposerView 深冻结副本，不冻结或共享原会话目标', () => {
  const project = { hostId: 'host', projectId: 'original-project' }
  const session = { hostId: 'host', sessionId: 'session', project } as PluginComposerOptions['session']
  const { result } = fixture([], session)
  act(() => result.current.chat.setDraft('不能误改其他插件的快照'))
  const view = result.current.composer.view!
  expect(Object.isFrozen(view)).toBe(true)
  expect(Object.isFrozen(view.document)).toBe(true)
  if (view.ref.target.kind !== 'project-draft') throw new Error('测试需要项目草稿')
  expect(view.ref.target.project).not.toBe(project)
  expect(Object.isFrozen(view.ref.target.project)).toBe(true)
  expect(Object.isFrozen(project)).toBe(false)
  expect(() => {
    project.projectId = 'still-editable'
  }).not.toThrow()
  expect(view.ref.target.project?.projectId).toBe('original-project')
})

test('运行中编辑经过 edit-message 处理器，阻止时不调用覆盖接口', async () => {
  const process = vi.fn<RegisteredBeforeSendHook['process']>(() => ({
    kind: 'block' as const,
    reason: '请先检查编辑内容',
  }))
  const { result, editAndPrompt } = fixture(
    [{ id: 'edit', title: '编辑检查', pluginId: 'plugin', generation: 1, intents: ['edit-message'], process }],
    { hostId: 'host', sessionId: 'session' } as PluginComposerOptions['session'],
  )
  const message = {
    role: 'user' as const,
    timestamp: 1,
    content: '旧消息',
    sourceEntry: { id: 'user-entry', type: 'message' as const, revision: '1' },
  }
  act(() => {
    result.current.chat.applyEvent({ type: 'message_end', message })
    result.current.chat.applyEvent({ type: 'agent_start' })
  })
  act(() => result.current.chat.editMessage(message))
  await act(async () => result.current.chat.send())
  expect(process).toHaveBeenCalledTimes(1)
  expect(process.mock.calls[0]?.[0]).toMatchObject({
    ref: { context: { kind: 'edit-message', message: { entryId: 'user-entry' } } },
  })
  expect(editAndPrompt).not.toHaveBeenCalled()
  expect(result.current.chat.chat.running).toBe(true)
  expect(result.current.chat.draft).toBe('旧消息')
})

test('继续停止任务使用所选配置，保留草稿且不调用历史编辑处理器', async () => {
  const process = vi.fn(() => ({ kind: 'pass' as const }))
  const { result, editAndPrompt, continueStopped } = fixture(
    [{ id: 'edit', title: '编辑检查', pluginId: 'plugin', generation: 1, intents: ['edit-message'], process }],
    { hostId: 'host', sessionId: 'session' } as PluginComposerOptions['session'],
  )
  act(() => {
    result.current.chat.applyEvent({
      type: 'message_end',
      message: {
        role: 'user',
        timestamp: 1,
        content: '旧消息',
        sourceEntry: { id: 'user-entry', type: 'message', revision: '1' },
      },
    })
    result.current.chat.applyEvent({ type: 'stop_update', stopped: true })
    result.current.chat.setDraft('保留草稿')
    result.current.chat.updateConfiguration({ thinkingLevel: 'high' })
  })
  await act(async () => result.current.chat.resume())
  expect(continueStopped).toHaveBeenCalledTimes(1)
  expect(continueStopped).toHaveBeenCalledWith('runtime', { thinkingLevel: 'high' })
  expect(editAndPrompt).not.toHaveBeenCalled()
  expect(process).not.toHaveBeenCalled()
  expect(result.current.chat.draft).toBe('保留草稿')
})

test('覆盖事件先于提交返回时插件快照保持稳定，完成后恢复主草稿且仅发送一次', async () => {
  const { result, editAndPrompt } = fixture([], {
    hostId: 'host',
    sessionId: 'session',
  } as PluginComposerOptions['session'])
  const pending = Promise.withResolvers<Awaited<ReturnType<ChatBridge['editAndPrompt']>>>()
  editAndPrompt.mockReturnValue(pending.promise)
  const message = {
    role: 'user' as const,
    timestamp: 1,
    content: '原消息',
    sourceEntry: { id: 'old-entry', type: 'message' as const, revision: '1' },
  }
  act(() => {
    result.current.chat.applyEvent({ type: 'message_end', message })
    result.current.chat.setDraft('保留主草稿')
  })
  act(() => result.current.chat.editMessage(message))
  let sending!: Promise<void>
  await act(async () => {
    sending = result.current.chat.send()
  })
  await act(async () => result.current.chat.send())
  act(() =>
    result.current.chat.restoreChat({
      ...result.current.chat.chat,
      messages: [{ ...message, sourceEntry: { ...message.sourceEntry, id: 'new-entry' } }],
    }),
  )
  expect(result.current.composer.adapter.current()).toBeNull()
  expect(result.current.chat.editSubmitting).toBe(true)
  await act(async () => {
    pending.resolve({ recoveredInputs: [] })
    await sending
  })
  expect(editAndPrompt).toHaveBeenCalledTimes(1)
  expect(result.current.chat.draft).toBe('保留主草稿')
  expect(result.current.chat.editing).toBe(false)
  expect(result.current.composer.adapter.current()).toBe(result.current.composer.view)
})
