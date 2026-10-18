import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeBlock } from '../src/ui/content/code-block'
import { getHighlighter } from '../src/ui/content/use-highlighter'

beforeAll(async () => {
  await getHighlighter()
})
afterEach(cleanup)

test.each(['typescript', 'unknown-language'])('代码块可折叠，%s 更新保留折叠状态并复制完整内容', async (language) => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const code = 'const value = 1'
  const updated = `${code}\nconsole.log(value)`
  const { rerender } = render(<CodeBlock code={code} language={language} />)
  const trigger = screen.getByRole('button', { name: '折叠代码块' })
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const contentId = trigger.getAttribute('aria-controls')!
  expect(document.getElementById(contentId)).toHaveTextContent(code)

  trigger.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '展开代码块' })).toHaveAttribute('aria-expanded', 'false')
  rerender(<CodeBlock code={updated} language={language} />)
  expect(screen.getByRole('button', { name: '展开代码块' })).toHaveAttribute('aria-expanded', 'false')
  expect(document.getElementById(contentId)).not.toBeVisible()

  await user.click(screen.getByRole('button', { name: '复制代码' }))
  expect(writeText).toHaveBeenCalledExactlyOnceWith(updated)
  expect(screen.getByRole('button', { name: '已复制' })).toBeVisible()
  const collapsed = screen.getByRole('button', { name: '展开代码块' })
  expect(collapsed).toHaveAttribute('aria-expanded', 'false')
  collapsed.focus()
  await user.keyboard(' ')
  expect(screen.getByRole('button', { name: '折叠代码块' })).toHaveAttribute('aria-expanded', 'true')
  expect(document.getElementById(contentId)).toBeVisible()
  expect(document.getElementById(contentId)?.textContent).toContain(updated)
})
