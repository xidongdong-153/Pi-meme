import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiBranchEntry, PiSessionEntries } from '@pi-meme/contracts/pi'
import { buildSessionTreeRows } from '../src/ui/model/session-tree-rows'
import { HistoryMarkdown } from '../src/ui/history-markdown'

test('历史预览保留列表编号、表格对齐和警告块', () => {
  const markup = renderToStaticMarkup(
    createElement(HistoryMarkdown, {
      children:
        '999. 第一项\n1000. 第二项\n\n- [x] 完成\n\n| 名称 | 金额 |\n| :--- | ---: |\n| 项目 | 8 |\n\n> [!WARNING]\n> 注意风险',
    }),
  )
  assert.match(markup, /<ol[^>]*start="999"[^>]*padding-left:5\.5ch/)
  assert.match(markup, /task-list-item/)
  assert.match(markup, /text-align:right/)
  assert.match(markup, /pi-alert-warning/)
  assert.doesNotMatch(markup, /\[!WARNING\]/)
})

type Node = PiBranchEntry

function build(
  entries: Node[],
  leafId: string | null,
  overrides: Partial<{
    filterMode: 'default' | 'all' | 'user' | 'no-tools'
    searchQuery: string
    foldedIds: Set<string>
  }> = {},
) {
  const data: PiSessionEntries = { entries, leafId }
  return buildSessionTreeRows(data, {
    filterMode: overrides.filterMode ?? 'default',
    searchQuery: overrides.searchQuery ?? '',
    foldedIds: overrides.foldedIds ?? new Set(),
  })
}

/** 没有分支的长单链：system -> user -> assistant -> toolResult -> assistant ... */
function chain(length: number): Node[] {
  const nodes: Node[] = [{ id: 'n0', parentId: null, timestamp: 't0', type: 'message', role: 'system' }]
  for (let index = 1; index < length; index++) {
    nodes.push({
      id: `n${index}`,
      parentId: `n${index - 1}`,
      timestamp: `t${String(index).padStart(3, '0')}`,
      type: 'message',
      role: index % 2 === 1 ? 'user' : 'assistant',
      preview: `第 ${index} 条`,
      messageTimestamp: index % 2 === 1 ? index : undefined,
    })
  }
  return nodes
}

test('长单链会话保持零缩进，不随深度把内容推出可视区', () => {
  const result = build(chain(60), 'n59')
  assert.equal(result.rows.length, 60)
  for (const row of result.rows) {
    assert.equal(row.indent, 0)
    assert.equal(row.showConnector, false)
    assert.deepEqual(row.gutters, [])
  }
})

test('分支点子节点缩进一级并带连接线，分支后的第一代再缩进但不带连接线', () => {
  const nodes: Node[] = [
    { id: 'u', parentId: null, timestamp: 't0', type: 'message', role: 'user', messageTimestamp: 1, preview: '问题' },
    { id: 'a1', parentId: 'u', timestamp: 't1', type: 'message', role: 'assistant', preview: '答案一' },
    { id: 'a1c', parentId: 'a1', timestamp: 't2', type: 'message', role: 'user', messageTimestamp: 2, preview: '追问' },
    { id: 'a2', parentId: 'u', timestamp: 't3', type: 'message', role: 'user', messageTimestamp: 3, preview: '改问' },
  ]
  const result = build(nodes, 'a1c')
  const byId = new Map(result.rows.map((row) => [row.entry.id, row]))
  assert.equal(byId.get('u')?.indent, 0)
  assert.equal(byId.get('a1')?.indent, 1)
  assert.equal(byId.get('a1')?.showConnector, true)
  assert.equal(byId.get('a2')?.indent, 1)
  assert.equal(byId.get('a2')?.isLast, true)
  assert.equal(byId.get('a1c')?.indent, 2)
  assert.equal(byId.get('a1c')?.showConnector, false)
})

test('默认过滤隐藏记账条目和只有工具调用的助手，可见子节点挂到最近可见祖先', () => {
  const nodes: Node[] = [
    {
      id: 'u',
      parentId: null,
      timestamp: 't0',
      type: 'message',
      role: 'user',
      messageTimestamp: 1,
      preview: '跑一下 lint',
    },
    { id: 'a1', parentId: 'u', timestamp: 't1', type: 'message', role: 'assistant' },
    { id: 'tr', parentId: 'a1', timestamp: 't2', type: 'message', role: 'toolResult', preview: '[bash: pnpm lint]' },
    { id: 'model', parentId: 'tr', timestamp: 't3', type: 'model_change' },
    { id: 'a2', parentId: 'model', timestamp: 't4', type: 'message', role: 'assistant', preview: 'lint 通过' },
  ]
  const result = build(nodes, 'a2')
  // a1 只有工具调用、model_change 属于记账条目，都从默认视图里跳过
  assert.deepEqual(
    result.rows.map((row) => row.entry.id),
    ['u', 'tr', 'a2'],
  )
  // 折叠 u 能收起 tr 和 a2，说明隐藏节点的子节点确实挂到了最近可见祖先 u 上
  const folded = build(nodes, 'a2', { foldedIds: new Set(['u']) })
  assert.deepEqual(
    folded.rows.map((row) => row.entry.id),
    ['u'],
  )
})

test('折叠分支点后隐藏它的可见子树', () => {
  const nodes: Node[] = [
    { id: 'u', parentId: null, timestamp: 't0', type: 'message', role: 'user', messageTimestamp: 1, preview: '问题' },
    { id: 'a1', parentId: 'u', timestamp: 't1', type: 'message', role: 'assistant', preview: '答案一' },
    { id: 'a2', parentId: 'u', timestamp: 't2', type: 'message', role: 'user', messageTimestamp: 2, preview: '改问' },
    { id: 'a2c', parentId: 'a2', timestamp: 't3', type: 'message', role: 'assistant', preview: '答案二' },
  ]
  const result = build(nodes, 'a1', { foldedIds: new Set(['u']) })
  assert.deepEqual(
    result.rows.map((row) => row.entry.id),
    ['u'],
  )
  assert.equal(result.rows[0].foldable, true)
  assert.equal(result.rows[0].folded, true)
})

test('仅用户模式只保留用户消息', () => {
  const nodes: Node[] = [
    { id: 'u', parentId: null, timestamp: 't0', type: 'message', role: 'user', messageTimestamp: 1, preview: '问题' },
    { id: 'a1', parentId: 'u', timestamp: 't1', type: 'message', role: 'assistant', preview: '答案' },
    { id: 'u2', parentId: 'a1', timestamp: 't2', type: 'message', role: 'user', messageTimestamp: 2, preview: '追问' },
  ]
  const result = build(nodes, 'u2', { filterMode: 'user' })
  assert.deepEqual(
    result.rows.map((row) => row.entry.id),
    ['u', 'u2'],
  )
})

test('内部协作报告与续跑控制不出现在任何主会话树过滤，真实用户引用仍保留', () => {
  const nodes: Node[] = [
    { id: 'u', parentId: null, timestamp: 't0', type: 'message', role: 'user', preview: '子 Agent 返回结果，用户引用' },
    {
      id: 'report',
      parentId: 'u',
      timestamp: 't1',
      type: 'custom_message',
      customType: 'pi-meme-collaboration',
      display: false,
      preview: '私有报告及ID',
    },
    {
      id: 'control',
      parentId: 'report',
      timestamp: 't2',
      type: 'custom_message',
      customType: 'pi-meme-collaboration-control',
      display: false,
      preview: '自动协作续跑正文',
    },
    { id: 'a', parentId: 'control', timestamp: 't3', type: 'message', role: 'assistant', preview: '继续答复' },
    {
      id: 'tool',
      parentId: 'a',
      timestamp: 't4',
      type: 'message',
      role: 'toolResult',
      toolName: 'spawn_agent',
      preview: '[spawn_agent: 私有任务正文及UUID]',
    },
  ]
  for (const filterMode of ['default', 'all', 'user', 'no-tools'] as const) {
    const result = build(nodes, 'a', { filterMode })
    assert.doesNotMatch(JSON.stringify(result.rows), /私有报告及ID|自动协作续跑正文|私有任务正文及UUID/)
    assert.ok(result.rows.some((row) => row.entry.id === 'u'))
  }
  assert.deepEqual(
    build(nodes, 'a', { filterMode: 'user' }).rows.map((row) => row.entry.id),
    ['u'],
  )
})
