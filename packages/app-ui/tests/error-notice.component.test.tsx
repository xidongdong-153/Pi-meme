import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorNotice } from '../src/layout/error-notice'

afterEach(cleanup)

test('错误提示移除 IPC 包装和重复前缀，保留实际原因', () => {
  render(
    <ErrorNotice
      message="Error: Error invoking remote method 'pi:prompt': Error: Pi 操作失败：Error: 模拟编辑提交失败"
      onOpenSettings={() => {}}
      onDismiss={() => {}}
    />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('Pi 操作失败：模拟编辑提交失败')
  expect(screen.getByRole('status')).not.toHaveTextContent('Error:')
  expect(screen.queryByRole('button', { name: '打开设置' })).not.toBeInTheDocument()
})

test('展开错误原因后可读取完整正文，关闭按钮实际通知调用者', async () => {
  const user = userEvent.setup()
  const dismiss = vi.fn()
  const { container } = render(
    <ErrorNotice message={'network error\n请求超时：/api/chat'} onOpenSettings={() => {}} onDismiss={dismiss} />,
  )
  const details = container.querySelector('details')!
  expect(details).not.toHaveAttribute('open')
  await user.click(screen.getByText('network error', { selector: 'span' }))
  expect(details).toHaveAttribute('open')
  expect(screen.getByText(/请求超时/, { selector: 'pre' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
  expect(dismiss).toHaveBeenCalledTimes(1)
})

test.each(['找不到 Pi CLI 或 Node.js：/missing-pi', 'Failed to load extension /tmp/broken.ts: 错误'])(
  '配置错误可通过按钮打开设置：%s',
  async (message) => {
    const user = userEvent.setup()
    const open = vi.fn()
    render(<ErrorNotice message={message} onOpenSettings={open} onDismiss={() => {}} />)
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent(message)
  },
)

test('普通英文原因保留，空消息不占用界面', () => {
  const { rerender, container } = render(
    <ErrorNotice message="Connection refused: localhost" onOpenSettings={() => {}} onDismiss={() => {}} />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('Connection refused: localhost')
  rerender(<ErrorNotice message="" onOpenSettings={() => {}} onDismiss={() => {}} />)
  expect(container).toBeEmptyDOMElement()
})
