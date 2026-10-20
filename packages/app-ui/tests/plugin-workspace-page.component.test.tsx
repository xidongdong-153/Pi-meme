import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useState } from 'react'
import type { HostApi } from '@pi-meme/contracts/app-host'
import type { RegisteredNavigation, RegisteredPage } from '@pi-meme/plugin-sdk/navigation'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { PluginWorkspacePage } from '../src/layout/plugin-workspace-page'

afterEach(cleanup)

function Editor({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [text, setText] = useState('')
  return (
    <input
      aria-label="页面草稿"
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        onDirty(true)
      }}
    />
  )
}

test('同页换目标重挂表单，旧实例只释放旧目标dirty回调', () => {
  const firstDirty = vi.fn()
  const secondDirty = vi.fn()
  const page: RegisteredPage = {
    id: 'example:form',
    pluginId: 'example',
    generation: 1,
    title: '表单',
    scope: 'session',
    render: ({ page: state }) => <Editor onDirty={state.setUnsavedChanges} />,
  }
  const navigation: RegisteredNavigation = {
    pluginId: 'example',
    generation: 1,
    title: '工具',
    defaultPageId: page.id,
    groups: [],
  }
  const props = {
    page,
    pages: [page],
    navigation,
    host: () => ({}) as HostApi,
    nativeWindow: false,
    rail: null,
    back: { label: '返回聊天', onClick: vi.fn() },
    onOpen: vi.fn(),
    onParams: vi.fn(),
    onManage: vi.fn(),
  }
  const firstRoute = {
    kind: 'plugin' as const,
    pluginId: 'example',
    pageId: page.id,
    target: { hostId: 'host', session: { hostId: 'host', sessionId: 'first' } },
    params: null,
  }
  const { rerender } = render(
    <TooltipProvider>
      <PluginWorkspacePage {...props} route={firstRoute} onDirty={firstDirty} />
    </TooltipProvider>,
  )
  fireEvent.change(screen.getByRole('textbox', { name: '页面草稿' }), { target: { value: '第一个会话草稿' } })
  expect(firstDirty).toHaveBeenLastCalledWith(true)
  rerender(
    <TooltipProvider>
      <PluginWorkspacePage
        {...props}
        route={{ ...firstRoute, target: { hostId: 'host', session: { hostId: 'host', sessionId: 'second' } } }}
        onDirty={secondDirty}
      />
    </TooltipProvider>,
  )
  expect(screen.getByRole('textbox', { name: '页面草稿' })).toHaveValue('')
  expect(firstDirty).toHaveBeenLastCalledWith(false)
  expect(secondDirty).not.toHaveBeenCalled()
})

test('离开目标会话取消页面Host短scope，待确认写入不落到旧目标', async () => {
  let approve!: () => void
  const approval = new Promise<void>((resolve) => {
    approve = resolve
  })
  let writes = 0
  const signals: AbortSignal[] = []
  const host = (signal: AbortSignal): HostApi => {
    signals.push(signal)
    return {
      sessions: {
        submit: async () => {
          await approval
          if (signal.aborted) throw new Error('cancelled')
          writes++
          return undefined
        },
      },
    } as unknown as HostApi
  }
  const page: RegisteredPage = {
    id: 'example:write',
    pluginId: 'example',
    generation: 1,
    title: '写入',
    scope: 'session',
    render: ({ host, target }) => (
      <button
        onClick={() => {
          void host.sessions
            .submit(target.session!, { delivery: 'start', text: '确认后写入' }, { idempotencyKey: 'test-write' })
            .catch(() => {})
        }}
      >
        确认写入
      </button>
    ),
  }
  const navigation: RegisteredNavigation = {
    pluginId: 'example',
    generation: 1,
    title: '工具',
    defaultPageId: page.id,
    groups: [],
  }
  const props = {
    page,
    pages: [page],
    navigation,
    host,
    nativeWindow: false,
    rail: null,
    back: { label: '返回聊天', onClick: vi.fn() },
    onOpen: vi.fn(),
    onParams: vi.fn(),
    onManage: vi.fn(),
    onDirty: vi.fn(),
  }
  const route = {
    kind: 'plugin' as const,
    pluginId: 'example',
    pageId: page.id,
    target: { hostId: 'host', session: { hostId: 'host', sessionId: 'first' } },
    params: null,
  }
  const { rerender } = render(
    <TooltipProvider>
      <PluginWorkspacePage {...props} route={route} />
    </TooltipProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '确认写入' }))
  rerender(
    <TooltipProvider>
      <PluginWorkspacePage
        {...props}
        route={{ ...route, target: { hostId: 'host', session: { hostId: 'host', sessionId: 'second' } } }}
      />
    </TooltipProvider>,
  )
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
  await act(async () => approve())
  expect(writes).toBe(0)
})

test('业务菜单只打开显式页面，缺目标不创建会话；dirty通过宿主回调报告', () => {
  const host = { sessions: { create: vi.fn() } } as unknown as HostApi
  const onOpen = vi.fn()
  const onDirty = vi.fn()
  const pages: RegisteredPage[] = [
    {
      id: 'example:overview',
      pluginId: 'example',
      generation: 1,
      title: '概览',
      scope: 'app',
      render: ({ page }) => <button onClick={() => page.setUnsavedChanges(true)}>编辑配置</button>,
    },
    {
      id: 'example:session',
      pluginId: 'example',
      generation: 1,
      title: '会话详情',
      scope: 'session',
      render: () => null,
    },
  ]
  const navigation: RegisteredNavigation = {
    pluginId: 'example',
    generation: 1,
    title: '检查工具',
    defaultPageId: pages[0].id,
    groups: [{ id: 'main', items: pages.map((page) => ({ id: page.id, pageId: page.id })) }],
  }
  render(
    <TooltipProvider>
      <PluginWorkspacePage
        route={{ kind: 'plugin', pluginId: 'example', pageId: pages[0].id, target: { hostId: 'host' }, params: null }}
        page={pages[0]}
        pages={pages}
        navigation={navigation}
        host={() => host}
        nativeWindow={false}
        rail={null}
        back={{ label: '返回聊天', onClick: vi.fn() }}
        onOpen={onOpen}
        onParams={vi.fn()}
        onDirty={onDirty}
        onManage={vi.fn()}
      />
    </TooltipProvider>,
  )
  expect(screen.getByRole('button', { name: '会话详情' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '会话详情' }))
  expect(host.sessions.create).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '编辑配置' }))
  expect(onDirty).toHaveBeenLastCalledWith(true)
})
