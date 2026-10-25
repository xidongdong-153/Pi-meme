import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import type { ScheduleConfiguration, ScheduledTaskInput } from '@pi-meme/contracts/schedules'
import { TaskDialog } from '../src/ui/task-dialog'

afterEach(cleanup)
const defaults: ScheduleConfiguration = {
  model: { provider: 'fake', id: 'first' },
  thinkingLevel: 'medium',
  accessMode: 'workspace-write',
  agentPlugins: [],
}
function fixture(onSave = vi.fn(async (_input: ScheduledTaskInput) => {})) {
  const onClose = vi.fn()
  render(
    <TaskDialog
      projects={[]}
      defaults={defaults}
      locationLabel="此计算机"
      plugins={[]}
      renderModelPicker={() => <span>测试模型</span>}
      renderAccessSelector={() => <span>测试权限</span>}
      onClose={onClose}
      onSave={onSave}
    />,
  )
  return { user: userEvent.setup(), onClose, onSave }
}
test('创建前必须填写说明，保存完整默认配置且不隐式运行', async () => {
  const f = fixture()
  expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true)
  await f.user.type(screen.getByRole('textbox', { name: '任务名称' }), '每日回顾')
  await f.user.type(screen.getByRole('textbox', { name: '执行说明' }), '总结项目')
  await f.user.click(screen.getByRole('button', { name: '创建' }))
  await waitFor(() => expect(f.onSave).toHaveBeenCalledTimes(1))
  expect(f.onSave.mock.calls[0][0]).toMatchObject({
    name: '每日回顾',
    prompt: '总结项目',
    newSessionEachRun: true,
    notification: 'all',
    configuration: defaults,
    rule: { kind: 'daily', time: '09:00' },
  })
  expect(f.onClose).toHaveBeenCalledOnce()
})
test('高级会话开关正确保存，保存失败时显示原因并保留输入', async () => {
  const onSave = vi.fn(async (_input: ScheduledTaskInput) => {
    throw new Error('执行 Host 已断开')
  })
  const f = fixture(onSave)
  fireEvent.change(screen.getByRole('textbox', { name: '任务名称' }), { target: { value: '持续回顾' } })
  fireEvent.change(screen.getByRole('textbox', { name: '执行说明' }), { target: { value: '继续回顾' } })
  await f.user.click(screen.getByRole('button', { name: '高级' }))
  await f.user.click(screen.getByRole('switch', { name: '每次运行时都开启新聊天' }))
  await f.user.click(screen.getByRole('button', { name: '创建' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain('Host 已断开')
  expect((onSave.mock.calls[0][0] as { newSessionEachRun: boolean }).newSessionEachRun).toBe(false)
  expect((screen.getByRole('textbox', { name: '执行说明' }) as HTMLTextAreaElement).value).toBe('继续回顾')
  expect(f.onClose).not.toHaveBeenCalled()
})
test('无效时区会阻止创建并显示具体原因', async () => {
  const f = fixture()
  await f.user.type(screen.getByRole('textbox', { name: '任务名称' }), '回顾')
  await f.user.type(screen.getByRole('textbox', { name: '执行说明' }), '总结项目')
  await f.user.click(screen.getByRole('button', { name: '高级' }))
  fireEvent.change(screen.getByRole('combobox', { name: '时区' }), { target: { value: 'invalid-zone' } })
  expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/时区无效/)).toBeTruthy()
  expect(f.onSave).not.toHaveBeenCalled()
})

test('填写较久后创建间隔任务，起点使用保存时刻', async () => {
  const f = fixture()
  await f.user.type(screen.getByRole('textbox', { name: '任务名称' }), '间隔验证')
  await f.user.type(screen.getByRole('textbox', { name: '执行说明' }), '验证时间')
  await f.user.click(screen.getByRole('combobox', { name: '运行频率' }))
  await f.user.click(screen.getByRole('option', { name: '固定间隔' }))
  const savedAt = new Date(Date.now() + 300000)
  vi.useFakeTimers({ now: savedAt })
  try {
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '创建' })))
    expect(f.onSave.mock.calls[0][0].rule).toMatchObject({ kind: 'interval', anchor: savedAt.toISOString() })
  } finally {
    vi.useRealTimers()
  }
})
