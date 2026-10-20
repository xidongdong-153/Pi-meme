import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { EventSubscription, HostApi, HostControlEvent, SessionRef } from '@pi-meme/contracts/app-host'
import type { ServiceActivity } from '@pi-meme/contracts/service-activity'
import { ActivityPanel, activityAddress } from '../src/ui/activity-panel'
import { ActivityStore } from '../src/ui/activity-store'

afterEach(cleanup)

const ref: SessionRef = { hostId: 'host', sessionId: 'session' }
function service(id: string, status: ServiceActivity['status'] = 'running'): ServiceActivity {
  return {
    ...ref,
    serviceId: id,
    name: id,
    command: 'pnpm run start:web',
    cwd: '/workspace',
    sourceName: '主 Agent',
    accessMode: 'workspace-write',
    status,
    startedAt: new Date().toISOString(),
    urls: ['http://localhost:5173'],
    revision: 1,
  }
}
function fixture(activities = [service('web'), service('api')]) {
  let listener: ((event: HostControlEvent) => void) | undefined
  const off = vi.fn()
  const list = vi.fn(async () => ({ activities, revision: 1, cursor: { journalEpoch: 'epoch', seq: 1 } }))
  const stop = vi.fn(async (_ref: SessionRef, id: string) => ({ ...service(id, 'stopped'), revision: 2 }))
  const logs = vi.fn(async () => ({ output: 'ready', sequence: 1, truncated: false }))
  const subscribe = vi.fn(async (_input: EventSubscription, callback: (event: HostControlEvent) => void) => {
    listener = callback
    return off
  })
  const submit = vi.fn()
  const host = { activities: { list, stop, logs }, events: { subscribe }, sessions: { submit } } as unknown as HostApi
  const store = new ActivityStore(host)
  const release = store.watch(ref)
  return {
    store,
    release,
    list,
    stop,
    logs,
    subscribe,
    submit,
    off,
    emit: (value: Partial<HostControlEvent>) =>
      listener?.({ hostId: 'host', sessionId: 'session', ...value } as HostControlEvent),
  }
}

test('停止仅作用该行，失败可重试；卸载与释放订阅绝不停止其他服务或调用模型', async () => {
  const context = fixture()
  let reject!: (cause: Error) => void
  context.stop.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  await waitFor(() => expect(context.subscribe).toHaveBeenCalledOnce())
  const view = render(<ActivityPanel store={context.store} session={ref} local />)
  fireEvent.click(screen.getByRole('button', { name: '停止 web' }))
  expect(screen.getByRole('button', { name: '停止 web' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '停止 api' })).toBeEnabled()
  expect(context.stop).toHaveBeenCalledWith(ref, 'web', { idempotencyKey: expect.any(String) })
  await act(async () => reject(new Error('暂时无法停止')))
  expect(screen.getByRole('alert')).toHaveTextContent('暂时无法停止')
  fireEvent.click(screen.getByRole('button', { name: '停止 web' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '停止 web' })).not.toBeInTheDocument())
  view.unmount()
  context.release()
  context.store.dispose()
  expect(context.stop).toHaveBeenCalledTimes(2)
  expect(context.submit).not.toHaveBeenCalled()
  expect(context.off).toHaveBeenCalledOnce()
})

test('后端停止清理失败但仍处于stopping时允许重试', async () => {
  const context = fixture([{ ...service('web', 'stopping'), lastError: '仍有后代进程' }])
  await waitFor(() => expect(context.subscribe).toHaveBeenCalledOnce())
  const view = render(<ActivityPanel store={context.store} session={ref} local />)
  expect(screen.getByRole('button', { name: '停止 web' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '停止 web' }))
  await waitFor(() => expect(context.stop).toHaveBeenCalledOnce())
  view.unmount()
  context.release()
  context.store.dispose()
})

test('日志仅展开时读取；远程回环地址只复制，不打开用户本机页面', async () => {
  const context = fixture([service('web')])
  await waitFor(() => expect(context.subscribe).toHaveBeenCalledOnce())
  const view = render(<ActivityPanel store={context.store} session={ref} local={false} />)
  expect(context.logs).not.toHaveBeenCalled()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看日志' }))
  await waitFor(() => expect(screen.getByLabelText('web 日志')).toHaveTextContent('ready'))
  expect(context.logs).toHaveBeenCalledWith(ref, 'web')
  act(() => context.emit({ type: 'activity', stream: 'live', value: { serviceId: 'web', logSequence: 2 } }))
  await waitFor(() => expect(context.logs).toHaveBeenCalledTimes(2))
  expect(context.list).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '收起日志' }))
  act(() => context.emit({ type: 'activity', stream: 'live', value: { serviceId: 'web', logSequence: 3 } }))
  expect(context.logs).toHaveBeenCalledTimes(2)
  view.unmount()
  context.release()
  context.store.dispose()
  expect(context.stop).not.toHaveBeenCalled()
  expect(activityAddress('javascript:alert(1)', true)).toBeUndefined()
  expect(activityAddress('http://user:secret@example.com', true)).toBeUndefined()
  expect(activityAddress('http://127.0.0.1:3000', false)?.openable).toBe(false)
  expect(activityAddress('http://[::1]:3000', false)?.openable).toBe(false)
  expect(activityAddress('https://example.com', false)?.openable).toBe(true)
})

test('断线保留快照，重连重新核对，resync不触发模型或停止', async () => {
  const context = fixture([service('web')])
  await waitFor(() => expect(context.subscribe).toHaveBeenCalledOnce())
  context.store.setConnected(false)
  const view = render(<ActivityPanel store={context.store} session={ref} local />)
  expect(screen.getByText('连接中断，状态待确认。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '停止 web' })).toBeDisabled()
  expect(context.store.state(ref).activities).toHaveLength(1)
  act(() => context.store.setConnected(true))
  await waitFor(() => expect(context.list).toHaveBeenCalledTimes(2))
  act(() => context.emit({ type: 'resync', value: { reason: 'reconnect' } }))
  await waitFor(() => expect(context.list).toHaveBeenCalledTimes(3))
  view.unmount()
  context.release()
  context.store.dispose()
  expect(context.stop).not.toHaveBeenCalled()
  expect(context.submit).not.toHaveBeenCalled()
})

test('切换正式会话后迟到读取不污染当前会话，订阅从列表游标衔接', async () => {
  const context = fixture()
  await waitFor(() => expect(context.subscribe).toHaveBeenCalledOnce())
  expect(context.subscribe.mock.calls[0][0]).toEqual({
    sessionId: ref.sessionId,
    after: { journalEpoch: 'epoch', seq: 1 },
  })
  let resolve!: (value: Awaited<ReturnType<typeof context.list>>) => void
  context.list.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const other = { hostId: 'host', sessionId: 'other' }
  const release = context.store.watch(other)
  release()
  context.store.watch(ref)
  resolve({
    activities: [{ ...service('other-service'), sessionId: 'other' }],
    revision: 2,
    cursor: { journalEpoch: 'epoch', seq: 2 },
  })
  await waitFor(() => expect(context.subscribe).toHaveBeenCalledTimes(2))
  expect(context.store.state(ref).activities.map((item) => item.serviceId)).toEqual(['web', 'api'])
  expect(context.store.state(other).known).toBe(false)
  context.store.dispose()
  expect(context.stop).not.toHaveBeenCalled()
})
