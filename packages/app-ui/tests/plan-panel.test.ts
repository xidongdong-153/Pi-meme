import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { PlanPanel } from '../src/plan-panel'
import { planExecutionDraft } from '../src/plan-execution-draft'
import { RightSidebar } from '../src/right-sidebar'

const older: PlanDocument = {
  id: 'older',
  sessionId: 'session',
  runId: 'run',
  revision: 1,
  title: '旧计划',
  markdown: '# 旧文档正文\n\n- 旧步骤',
  updatedAt: '2026-10-09T00:00:00Z',
}
const latest: PlanDocument = {
  ...older,
  id: 'latest',
  title: '新计划',
  markdown: '# 完整计划正文\n\n- 第一步\n- 第二步\n\n最后一段',
  revision: 2,
  updatedAt: '2026-10-10T00:00:00Z',
}
function renderPanel(documents: PlanDocument[], selectedId?: string) {
  return renderToStaticMarkup(createElement(PlanPanel, { documents, selectedId, onSelect: () => {} }))
}

test('右栏计划标签显示完整只读 Markdown，保留复制与导出，无折叠预览', () => {
  const markup = renderToStaticMarkup(
    createElement(RightSidebar, {
      tab: 'plan',
      availableTabs: ['plan'],
      onTab: () => {},
      onClose: () => {},
      width: 352,
      children: createElement(PlanPanel, { documents: [latest], onSelect: () => {} }),
    }),
  )
  assert.match(markup, /role="tab" aria-selected="true"[^>]*>计划<\/button>/)
  assert.match(markup, /aria-label="计划文档"[^>]*overflow-y-auto/)
  assert.match(markup, /aria-label="已保存计划：新计划"/)
  assert.match(markup, /<h1[^>]*>完整计划正文<\/h1>/)
  assert.match(markup, /<li[^>]*>第一步<\/li>/)
  assert.match(markup, /<li[^>]*>第二步<\/li>/)
  assert.match(markup, /最后一段/)
  assert.match(markup, />复制<\/button>/)
  assert.match(markup, />导出 Markdown<\/button>/)
  assert.doesNotMatch(markup, /<details|预览计划|<textarea|contenteditable|选择计划文档/)
})

test('多篇计划默认显示最新，可选择旧文档；无效选择回到当前会话最新文档', () => {
  const documents = [older, latest]
  const markup = renderPanel(documents)
  assert.match(markup, /role="combobox"[^>]*aria-label="选择计划文档"/)
  assert.match(markup, /aria-label="已保存计划：新计划"/)
  assert.match(markup, /完整计划正文/)
  assert.doesNotMatch(markup, /旧文档正文/)
  const previous = renderPanel(documents, older.id)
  assert.match(previous, /aria-label="已保存计划：旧计划"/)
  assert.match(previous, /旧文档正文/)
  assert.doesNotMatch(previous, /完整计划正文/)
  assert.match(renderPanel(documents, 'other-session-plan'), /完整计划正文/)
  assert.deepEqual(documents, [older, latest])
})

test('按当前选择的计划准备草稿，保留原输入、完整正文和修订；运行中禁用继续', () => {
  const draft = planExecutionDraft('已有要求  ', latest)
  assert.match(draft, /^已有要求\n\n请按已保存的计划「新计划」（第 2 版）继续执行。/)
  assert.ok(draft.endsWith(latest.markdown))
  assert.equal(planExecutionDraft('', older), `请按已保存的计划「旧计划」（第 1 版）继续执行。\n\n${older.markdown}`)
  for (const disabled of [false, true]) {
    const markup = renderToStaticMarkup(
      createElement(PlanPanel, {
        documents: [older, latest],
        selectedId: older.id,
        onSelect: () => {},
        onContinue: () => assert.fail('渲染计划不执行回调'),
        continueDisabled: disabled,
      }),
    )
    assert.match(markup, /按此计划继续/)
    assert.match(markup, /不会自动发送/)
    assert.match(markup, /旧文档正文/)
    assert.equal(/<button[^>]*disabled=""[^>]*>按此计划继续<\/button>/.test(markup), disabled)
  }
})

test('空会话计划栏显示空态，不呈现其他会话的选择和文档操作', () => {
  const markup = renderPanel([], latest.id)
  assert.match(markup, /当前会话还没有保存的计划。/)
  assert.doesNotMatch(markup, /已保存计划|选择计划文档|复制|导出 Markdown|完整计划正文/)
})
