import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { PlanDecision } from '../src/panels/plan-decision'
import { PlanCard } from '../src/panels/plan-card'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'

afterEach(() => {
  cleanup()
  localStorage.clear()
})
const document: PlanDocument = {
  id: 'plan',
  sessionId: 'session',
  runId: 'run',
  revision: 1,
  title: '改造计划',
  markdown: '# 改造计划\n\n完整正文',
  updatedAt: '2026-10-26T00:00:00Z',
}
function fixture(overrides: Partial<Parameters<typeof PlanDecision>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(true)
  const onSkip = vi.fn()
  const props = {
    document,
    hostId: 'host',
    visible: true,
    readOnly: false,
    model: <button>模型与思考强度</button>,
    access: <button>访问权限</button>,
    onSubmit,
    onSkip,
    children: <textarea aria-label="普通输入框" defaultValue="原草稿" />,
    ...overrides,
  }
  return { ...render(<PlanDecision {...props} />), props, onSubmit, onSkip }
}
test('实施绑定当前修订，保留普通草稿，等待期间防止重复提交', async () => {
  const user = userEvent.setup()
  let resolve!: (value: boolean) => void
  const onSubmit = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done
      }),
  )
  fixture({ onSubmit })
  await user.dblClick(screen.getByRole('button', { name: '是，实施此计划' }))
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
    { intent: 'execute', reference: { id: 'plan', revision: 1 } },
    undefined,
  )
  resolve(true)
  expect(await screen.findByRole('textbox', { name: '普通输入框' })).toHaveValue('原草稿')
})
test('调整通过聊天提交，失败时保留输入供重试', async () => {
  const user = userEvent.setup()
  const { onSubmit } = fixture()
  onSubmit.mockResolvedValueOnce(false)
  await user.type(screen.getByRole('textbox', { name: '计划调整要求' }), '先改 UI')
  await user.click(screen.getByRole('button', { name: '发送计划调整要求' }))
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
    { intent: 'revise', reference: { id: 'plan', revision: 1 } },
    '先改 UI',
  )
  expect(screen.getByRole('textbox', { name: '计划调整要求' })).toHaveValue('先改 UI')
})
test('跳过与关闭不提交，保留文本，同修订重挂载不重复询问，新修订再次询问', async () => {
  const user = userEvent.setup()
  const first = fixture()
  await user.type(screen.getByRole('textbox', { name: '计划调整要求' }), '尚未发送的调整')
  await user.click(screen.getByRole('button', { name: '关闭并跳过计划选择' }))
  expect(first.onSubmit).not.toHaveBeenCalled()
  expect(first.onSkip).toHaveBeenCalledExactlyOnceWith('尚未发送的调整')
  first.unmount()
  const second = fixture()
  expect(screen.queryByRole('region', { name: '实施此计划' })).not.toBeInTheDocument()
  second.unmount()
  const third = fixture({ document: { ...document, revision: 2 } })
  await user.click(screen.getByRole('button', { name: '跳过' }))
  expect(third.onSubmit).not.toHaveBeenCalled()
  expect(third.onSkip).toHaveBeenCalledExactlyOnceWith('')
})
test('只读权限不能直接实施，模型与权限入口可用', () => {
  fixture({ readOnly: true })
  expect(screen.getByRole('button', { name: '是，实施此计划' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '访问权限' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '模型与思考强度' })).toBeEnabled()
})
test('计划卡片复制完整正文并打开侧栏，不在卡片内展开', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const onOpen = vi.fn()
  render(
    <TooltipProvider>
      <PlanCard document={document} onOpen={onOpen} />
    </TooltipProvider>,
  )
  await user.click(screen.getByRole('button', { name: '复制完整计划' }))
  expect(copy).toHaveBeenCalledExactlyOnceWith(document.markdown)
  await user.click(screen.getByRole('button', { name: '在侧栏打开完整计划' }))
  expect(onOpen).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '保存计划' })).toBeVisible()
})
