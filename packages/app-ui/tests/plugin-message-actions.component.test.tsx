import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { MessageRef, UiMessage, UiMessageRole } from '@pi-meme/contracts/plugin-ui-data'
import type { MessageActionAnchor } from '@pi-meme/ui/components/plugin-message-actions'
import type { RegisteredMessageAction } from '@pi-meme/plugin-sdk/message-actions'
import type { UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import type { UiPluginRegistry } from '../src/plugins/plugin-registry'
import { PluginMessageActionMenu } from '../src/plugins/plugin-message-actions'

afterEach(cleanup)
const target = { hostId: 'host', session: { hostId: 'host', sessionId: 'session' } }
const props: UiContributionProps = {
  host: {} as HostApi,
  target,
  snapshot: { status: 'ready', running: true, mode: 'plan', agentPlugins: [] },
}
function fixture(role: UiMessageRole) {
  const execute = vi.fn<RegisteredMessageAction['execute']>(async () => {})
  const action: RegisteredMessageAction = {
    id: 'example:save',
    pluginId: 'example',
    generation: 1,
    title: '保存消息',
    match: { roles: [role], source: 'any' },
    execute,
  }
  const message: UiMessage = {
    id: 'native',
    ref: { session: target.session, entryId: 'native' },
    role,
    revision: 'r1',
    state: 'complete',
    text: '正文',
    images: [],
  }
  const getMessage = vi.fn(async () => message)
  const context = { host: props.host, messages: { getMessage }, signal: new AbortController().signal }
  const actions = [action]
  const registry = {
    subscribe: () => () => {},
    getMessageActions: () => actions,
    getMessageActionContext: vi.fn(() => context),
  } as unknown as UiPluginRegistry
  const anchor = {
    role,
    entries: [{ id: 'native', revision: 'r1' }],
    state: 'complete' as const,
    displayedText: '正文',
  }
  return { execute, getMessage, registry, anchor }
}

for (const role of ['user', 'assistant', 'tool', 'custom'] as const) {
  test(`${role} 已持久消息可在 Plan 和运行期间手动执行，携带原目标及引用`, async () => {
    const { registry, anchor, execute } = fixture(role)
    render(<PluginMessageActionMenu registry={registry} props={props} anchor={anchor} />)
    fireEvent.keyDown(screen.getByRole('button', { name: '插件消息操作' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '保存消息' }))
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      subject: { role, refs: [{ session: target.session, entryId: 'native' }] },
      target,
    })
  })
}

test('聚合摘要单菜单逐调用匹配真实来源和工具名，同一动作跨工具不互锁且换数组不取消', async () => {
  let readSignal: AbortSignal | undefined
  const quote = vi.fn<RegisteredMessageAction['execute']>((context) => {
    if (context.subject.toolCallId !== 'call-read') return Promise.resolve()
    readSignal = context.signal
    return new Promise(() => {})
  })
  const actions: RegisteredMessageAction[] = [
    {
      id: 'observer:quote',
      pluginId: 'observer',
      generation: 3,
      title: '引用到草稿',
      match: { roles: ['tool'], source: 'any' },
      execute: quote,
    },
    {
      id: 'read-plugin:self',
      pluginId: 'read-plugin',
      generation: 1,
      title: '本插件工具',
      match: { roles: ['tool'], source: 'self' },
      execute: () => {},
    },
    {
      id: 'observer:read',
      pluginId: 'observer',
      generation: 3,
      title: '读取工具专属',
      match: { roles: ['tool'], source: 'any', toolName: 'sdk_read_workspace' },
      execute: () => {},
    },
  ]
  const anchors: MessageActionAnchor[] = [
    {
      role: 'tool',
      entries: [{ id: 'native-read', revision: 'r-read' }],
      displayedText: '读取结果',
      state: 'complete',
      toolCallId: 'call-read',
      toolName: 'sdk_read_workspace',
      source: { ownerId: 'read-plugin', generation: 1 },
    },
    {
      role: 'tool',
      entries: [{ id: 'native-search', revision: 'r-search' }],
      displayedText: '搜索错误',
      state: 'error',
      toolCallId: 'call-search',
      toolName: 'sdk_search_workspace',
      source: { ownerId: 'search-plugin', generation: 2 },
    },
  ]
  const getMessage = vi.fn(async (ref: MessageRef): Promise<UiMessage> => ({
    id: ref.entryId,
    ref,
    role: 'tool',
    revision: ref.entryId === 'native-read' ? 'r-read' : 'r-search',
    state: 'complete',
    text: '真实结果',
    images: [],
  }))
  const context = { host: props.host, messages: { getMessage }, signal: new AbortController().signal }
  const registry = {
    subscribe: () => () => {},
    getMessageActions: () => actions,
    getMessageActionContext: () => context,
  } as unknown as UiPluginRegistry
  const { rerender } = render(<PluginMessageActionMenu registry={registry} props={props} anchors={anchors} />)
  expect(screen.getAllByRole('button', { name: '插件消息操作' })).toHaveLength(1)
  const open = () => fireEvent.keyDown(screen.getByRole('button', { name: '插件消息操作' }), { key: 'ArrowDown' })
  open()
  const read = await screen.findByRole('group', { name: /sdk_read_workspace.*call-read/ })
  const search = screen.getByRole('group', { name: /sdk_search_workspace.*call-search/ })
  expect(within(read).getByRole('menuitem', { name: '本插件工具' })).toBeEnabled()
  expect(within(read).getByRole('menuitem', { name: '读取工具专属' })).toBeEnabled()
  expect(within(search).queryByRole('menuitem', { name: '本插件工具' })).not.toBeInTheDocument()
  expect(within(search).queryByRole('menuitem', { name: '读取工具专属' })).not.toBeInTheDocument()
  fireEvent.click(within(read).getByRole('menuitem', { name: '引用到草稿' }))
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(1))
  rerender(<PluginMessageActionMenu registry={registry} props={props} anchors={structuredClone(anchors)} />)
  expect(readSignal?.aborted).toBe(false)
  open()
  fireEvent.click(
    within(await screen.findByRole('group', { name: /sdk_search_workspace.*call-search/ })).getByRole('menuitem', {
      name: '引用到草稿',
    }),
  )
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(2))
  expect(getMessage.mock.calls.map(([ref]) => ref.entryId)).toEqual(['native-read', 'native-search'])
  expect(quote.mock.calls[0][0].subject.refs).toEqual([{ session: target.session, entryId: 'native-read' }])
  expect(quote.mock.calls[1][0].subject).toMatchObject({
    toolCallId: 'call-search',
    toolName: 'sdk_search_workspace',
    source: { ownerId: 'search-plugin', generation: 2 },
    refs: [{ session: target.session, entryId: 'native-search' }],
  })
  rerender(
    <PluginMessageActionMenu
      registry={registry}
      props={props}
      anchors={[{ ...anchors[0], entries: [{ id: 'native-read', revision: 'changed' }] }]}
    />,
  )
  expect(readSignal?.aborted).toBe(true)
})

test('未持久或当前流式消息不伪造动作入口', () => {
  const { registry, anchor } = fixture('assistant')
  const { rerender } = render(
    <PluginMessageActionMenu registry={registry} props={props} anchor={{ ...anchor, entries: [] }} />,
  )
  expect(screen.queryByRole('button', { name: '插件消息操作' })).not.toBeInTheDocument()
  rerender(<PluginMessageActionMenu registry={registry} props={props} anchor={{ ...anchor, state: 'streaming' }} />)
  expect(screen.queryByRole('button', { name: '插件消息操作' })).not.toBeInTheDocument()
})

test('等待读取时消息修订变化取消旧操作，不向后来主体提交', async () => {
  const { registry, anchor, execute, getMessage } = fixture('custom')
  let resolve!: (message: UiMessage) => void
  getMessage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const { rerender } = render(<PluginMessageActionMenu registry={registry} props={props} anchor={anchor} />)
  fireEvent.keyDown(screen.getByRole('button', { name: '插件消息操作' }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '保存消息' }))
  rerender(
    <PluginMessageActionMenu
      registry={registry}
      props={props}
      anchor={{ ...anchor, entries: [{ id: 'other', revision: 'r2' }] }}
    />,
  )
  await act(async () =>
    resolve({ id: 'native', role: 'custom', revision: 'r1', state: 'complete', text: '旧正文', images: [] }),
  )
  expect(execute).not.toHaveBeenCalled()
})

test('同ID动作按插件和代次隔离busy，列表退役立即取消忽略signal的旧处理器', async () => {
  const { anchor } = fixture('user')
  let oldSignal: AbortSignal | undefined
  let nextSignal: AbortSignal | undefined
  const first = vi.fn<RegisteredMessageAction['execute']>((context) => {
    oldSignal = context.signal
    return new Promise(() => {})
  })
  const second = vi.fn<RegisteredMessageAction['execute']>(async () => {})
  const next = vi.fn<RegisteredMessageAction['execute']>((context) => {
    nextSignal = context.signal
    return new Promise(() => {})
  })
  const makeAction = (
    pluginId: string,
    title: string,
    generation: number,
    execute: RegisteredMessageAction['execute'],
  ): RegisteredMessageAction => ({
    id: 'same',
    pluginId,
    title,
    generation,
    match: { roles: ['user'], source: 'any' },
    execute,
  })
  let actions = [makeAction('one', '甲插件', 1, first), makeAction('two', '乙插件', 1, second)]
  const listeners = new Set<() => void>()
  const context = {
    host: props.host,
    messages: {
      getMessage: async () => ({
        id: 'native',
        ref: { session: target.session, entryId: 'native' },
        role: 'user',
        revision: 'r1',
        state: 'complete',
        text: '正文',
        images: [],
      }),
    },
    signal: new AbortController().signal,
  }
  const getContext = vi.fn((_action: RegisteredMessageAction, _signal?: AbortSignal) => context)
  const registry = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getMessageActions: () => actions,
    getMessageActionContext: getContext,
  } as unknown as UiPluginRegistry
  render(<PluginMessageActionMenu registry={registry} props={props} anchor={anchor} />)
  const open = () => fireEvent.keyDown(screen.getByRole('button', { name: '插件消息操作' }), { key: 'ArrowDown' })
  open()
  fireEvent.click(await screen.findByRole('menuitem', { name: '甲插件' }))
  await waitFor(() => expect(first).toHaveBeenCalledOnce())
  open()
  fireEvent.click(await screen.findByRole('menuitem', { name: '乙插件' }))
  await waitFor(() => expect(second).toHaveBeenCalledOnce())
  await waitFor(() => expect(second.mock.calls[0][0].signal.aborted).toBe(true))
  await act(async () => {
    actions = [makeAction('one', '甲插件新版', 2, next), actions[1]]
    for (const listener of listeners) listener()
  })
  expect(oldSignal?.aborted).toBe(true)
  open()
  fireEvent.click(await screen.findByRole('menuitem', { name: '甲插件新版' }))
  await waitFor(() => expect(next).toHaveBeenCalledOnce())
  await act(async () => {
    actions = [actions[1]]
    for (const listener of listeners) listener()
  })
  expect(nextSignal?.aborted).toBe(true)
  expect(getContext.mock.calls.every((call) => call[1] instanceof AbortSignal)).toBe(true)
})
