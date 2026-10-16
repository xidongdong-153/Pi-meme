import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PiUserInputRequest } from '@pi-meme/contracts/user-input'
import { UserInputPanel } from '../src/ui/user-input-panel'

afterEach(cleanup)

const request: PiUserInputRequest = {
  type: 'extension_ui_request',
  id: 'request-1',
  method: 'questions',
  questions: [
    {
      id: 'framework',
      question: '使用哪个框架？',
      options: [{ label: 'React', description: '沿用现有界面' }, { label: 'Vue' }],
    },
    { id: 'scope', question: '需要处理哪些页面？' },
    { id: 'deadline', question: '何时完成？', options: [{ label: '今天' }, { label: '本周' }] },
  ],
}

test('初始无答案且不能继续，选中后可换题，最后一次性提交全部答案', async () => {
  const user = userEvent.setup()
  const respond = vi.fn().mockResolvedValue(undefined)
  render(<UserInputPanel request={request} onRespond={respond} />)
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
  expect(screen.getAllByRole('radio').every((option) => option.getAttribute('aria-checked') === 'false')).toBe(true)
  await user.click(screen.getByRole('radio', { name: /React/ }))
  expect(respond).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.type(screen.getByRole('textbox', { name: '自行撰写回复' }), '聊天页')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.click(screen.getByRole('button', { name: '上一题' }))
  expect(screen.getByRole('textbox')).toHaveValue('聊天页')
  await user.click(screen.getByRole('button', { name: '下一题' }))
  await user.click(screen.getByRole('button', { name: '跳过' }))
  expect(respond).toHaveBeenCalledExactlyOnceWith('request-1', {
    answers: [
      { id: 'framework', value: 'React' },
      { id: 'scope', value: '聊天页' },
      { id: 'deadline', value: null },
    ],
  })
})

test('自行填写取消选项，发送失败后保留草稿并可重试', async () => {
  const user = userEvent.setup()
  const respond = vi.fn().mockRejectedValueOnce(new Error('连接断开')).mockResolvedValue(undefined)
  render(<UserInputPanel request={{ ...request, questions: [request.questions[0]] }} onRespond={respond} />)
  expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: /React/ }))
  await user.type(screen.getByRole('textbox'), 'TypeScript')
  expect(screen.getByRole('radio', { name: /React/ })).toHaveAttribute('aria-checked', 'false')
  await user.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByRole('status')).toHaveTextContent('连接断开')
  expect(screen.getByRole('textbox')).toHaveValue('TypeScript')
  await user.click(screen.getByRole('button', { name: '发送' }))
  expect(respond).toHaveBeenLastCalledWith('request-1', { answers: [{ id: 'framework', value: 'TypeScript' }] })
  expect(respond).toHaveBeenCalledTimes(2)
})

test('键盘选择更新焦点，输入法事件和文本框数字不选择答案', async () => {
  const user = userEvent.setup()
  render(<UserInputPanel request={{ ...request, questions: [request.questions[0]] }} onRespond={async () => {}} />)
  fireEvent.keyDown(screen.getByRole('region', { name: 'Agent 提问' }), { key: '1', keyCode: 229, isComposing: true })
  expect(screen.getByRole('radio', { name: /React/ })).toHaveAttribute('aria-checked', 'false')
  await user.click(screen.getByRole('radio', { name: /React/ }))
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('radio', { name: /Vue/ })).toHaveFocus()
  expect(screen.getByRole('radio', { name: /Vue/ })).toHaveAttribute('aria-checked', 'true')
  await user.type(screen.getByRole('textbox'), '1')
  expect(screen.getByRole('radio', { name: /React/ })).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByRole('textbox')).toHaveValue('1')
})

test('恢复最后一题的自填草稿，关闭操作发送取消响应', async () => {
  const user = userEvent.setup()
  const respond = vi.fn().mockResolvedValue(undefined)
  render(
    <UserInputPanel
      request={request}
      draft={{
        currentIndex: 2,
        drafts: [
          { selectedIndex: 0, text: '', skipped: false },
          { selectedIndex: null, text: '聊天', skipped: false },
          { selectedIndex: null, text: '明天', skipped: false },
        ],
      }}
      onRespond={respond}
    />,
  )
  expect(screen.getByRole('textbox')).toHaveValue('明天')
  expect(screen.getByRole('status', { name: '第 3 题，共 3 题' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '关闭问题' }))
  expect(respond).toHaveBeenCalledExactlyOnceWith(request.id, { cancelled: true })
})
