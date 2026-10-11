import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RightSidebar, type RightSidebarTab } from '../src/right-sidebar'

function renderSidebar(availableTabs: RightSidebarTab[], tab = availableTabs[0]) {
  return renderToStaticMarkup(
    createElement(RightSidebar, {
      availableTabs,
      tab,
      onTab: () => {},
      onClose: () => {},
      width: 352,
      children: null,
    }),
  )
}

test('右侧栏只呈现有内容的标签，保留固定顺序和当前选中状态', () => {
  const markup = renderSidebar(['plan', 'session-tree'], 'plan')
  assert.doesNotMatch(markup, />Git 变更<|>子代理</)
  assert.match(markup, /role="tab" aria-selected="false"[^>]*>会话树<\/button>/)
  assert.match(markup, /role="tab" aria-selected="true"[^>]*>计划<\/button>/)
  assert.ok(markup.indexOf('>会话树<') < markup.indexOf('>计划<'))
})

test('全部内容缺失时隐藏所有标签，仍保留关闭入口', () => {
  const markup = renderSidebar([])
  assert.doesNotMatch(markup, /role="tab"|role="tablist"|>Git 变更<|>会话树<|>子代理<|>计划</)
  assert.match(markup, /aria-label="关闭右侧栏"/)
})

test('单独存在 Git 或子代理时不附带其他空标签', () => {
  for (const [tab, label] of [
    ['git', 'Git 变更'],
    ['subagents', '子代理'],
  ] as const) {
    const markup = renderSidebar([tab])
    assert.equal(markup.match(/role="tab"/g)?.length, 1)
    assert.ok(markup.includes(`>${label}</button>`))
  }
})
