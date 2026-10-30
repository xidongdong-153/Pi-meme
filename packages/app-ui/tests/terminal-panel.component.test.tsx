import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { activate } from '@pi-meme/terminal/ui/entry'
import type { HostApi, HostControlEvent, TerminalSnapshot, WorkspaceRef } from '@pi-meme/contracts/app-host'
import type { UiPanel, UiTarget } from '@pi-meme/plugin-sdk/ui'

vi.mock('../../terminal/src/ui/terminal-console', () => ({
  TerminalConsole: ({ instance }: { instance: TerminalSnapshot }) => <pre>{instance.output}</pre>,
}))

afterEach(cleanup)

function snapshot(id = 'terminal'): TerminalSnapshot {
  return {
    hostId: 'host',
    terminalId: id,
    cwd: '/project',
    cols: 80,
    rows: 24,
    output: `输出：${id}`,
    outputSequence: 0,
    exited: false,
  }
}

async function setup(supported = true) {
  let panel!: UiPanel
  let emit!: (event: HostControlEvent) => void
  const terminal = {
    open: vi.fn(async (_root: WorkspaceRef) => snapshot()),
    attach: vi.fn(async (ref: { terminalId: string }) => snapshot(ref.terminalId)),
    close: vi.fn(async () => {}),
  }
  const host = {
    capabilities: async () => ({ features: supported ? ['terminal'] : [] }),
    events: {
      subscribe: async (_filter: unknown, listener: typeof emit) => {
        emit = listener
        return () => {}
      },
    },
    terminal,
  } as unknown as HostApi
  const dispose = await activate({
    host,
    panels: {
      register: (value) => {
        panel = value
        return () => {}
      },
      open: () => {},
    },
  })
  const target = { hostId: 'host', session: { hostId: 'host', sessionId: 'session' } }
  const view = (selected: UiTarget = target) => (
    <StrictMode>{panel.render({ host, target: selected, snapshot: null })}</StrictMode>
  )
  return { terminal, view, target, dispose, emit: (event: HostControlEvent) => emit(event) }
}

test('打开即启动，严格模式和启动中重新打开共用同一次请求', async () => {
  const { terminal, view } = await setup()
  let finish!: (value: TerminalSnapshot) => void
  terminal.open.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const first = render(view())
  expect(screen.getByRole('status')).toHaveTextContent('正在启动终端')
  expect(terminal.open).toHaveBeenCalledTimes(1)
  first.unmount()
  const second = render(view())
  expect(terminal.open).toHaveBeenCalledTimes(1)
  await act(async () => finish(snapshot()))
  expect(await screen.findByText('输出：terminal')).toBeVisible()
  second.unmount()
  render(view())
  expect(await screen.findByText('输出：terminal')).toBeVisible()
  expect(terminal.open).toHaveBeenCalledTimes(1)
  expect(terminal.close).not.toHaveBeenCalled()
})

test('启动失败不循环重试，重新打开时重试', async () => {
  const { terminal, view } = await setup()
  terminal.open.mockRejectedValueOnce(new Error('启动失败'))
  const first = render(view())
  expect(await screen.findByRole('alert')).toHaveTextContent('启动失败')
  first.rerender(view())
  expect(terminal.open).toHaveBeenCalledTimes(1)
  first.unmount()
  render(view())
  expect(await screen.findByText('输出：terminal')).toBeVisible()
  expect(terminal.open).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('连接失败重试已有实例，不创建第二个终端', async () => {
  const { terminal, view } = await setup()
  terminal.attach.mockRejectedValueOnce(new Error('连接失败'))
  const first = render(view())
  expect(await screen.findByRole('alert')).toHaveTextContent('连接失败')
  first.unmount()
  render(view())
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(terminal.attach).toHaveBeenCalledTimes(2)
  expect(terminal.open).toHaveBeenCalledTimes(1)
})

test('自然退出保留输出，重新打开时先释放旧实例再启动', async () => {
  const { terminal, view, emit } = await setup()
  const first = render(view())
  await screen.findByText('输出：terminal')
  act(() =>
    emit({
      type: 'terminal',
      journalEpoch: 'test',
      seq: 1,
      eventId: 'exit',
      hostId: 'host',
      timestamp: '2026-10-29T00:00:00.000Z',
      value: { terminalId: 'terminal', exitCode: 7 },
    }),
  )
  expect(screen.getByText('输出：terminal')).toBeVisible()
  expect(terminal.open).toHaveBeenCalledTimes(1)
  first.unmount()
  render(view())
  await waitFor(() => expect(terminal.open).toHaveBeenCalledTimes(2))
  expect(terminal.close.mock.invocationCallOrder[0]).toBeLessThan(terminal.open.mock.invocationCallOrder[1]!)
})

test('启动时切换会话，返回原会话恢复对应终端', async () => {
  const { terminal, view, target } = await setup()
  let finish!: (value: TerminalSnapshot) => void
  terminal.open.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  terminal.open.mockResolvedValueOnce(snapshot('second'))
  const ui = render(view())
  const next = { hostId: 'host', session: { hostId: 'host', sessionId: 'second' } }
  ui.rerender(view(next))
  expect(await screen.findByText('输出：second')).toBeVisible()
  await act(async () => finish(snapshot('first')))
  expect(screen.queryByText('输出：first')).not.toBeInTheDocument()
  ui.rerender(view(target))
  expect(await screen.findByText('输出：first')).toBeVisible()
  expect(terminal.open.mock.calls.map(([root]) => root)).toEqual([target.session, next.session])
})

test('无终端能力或无目标时不启动', async () => {
  const unsupported = await setup(false)
  const first = render(unsupported.view())
  expect(screen.getByRole('status')).toHaveTextContent('无法启动终端')
  expect(unsupported.terminal.open).not.toHaveBeenCalled()
  first.unmount()
  const supported = await setup()
  render(supported.view({ hostId: 'host' }))
  expect(screen.getByRole('status')).toHaveTextContent('选择项目或会话')
  expect(supported.terminal.open).not.toHaveBeenCalled()
})

test('功能卸载后迟到的启动结果会被释放', async () => {
  const { terminal, view, dispose } = await setup()
  let finish!: (value: TerminalSnapshot) => void
  terminal.open.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const ui = render(view())
  ui.unmount()
  await dispose()
  await act(async () => finish(snapshot()))
  expect(terminal.close).toHaveBeenCalledTimes(1)
  expect(terminal.attach).not.toHaveBeenCalled()
})
