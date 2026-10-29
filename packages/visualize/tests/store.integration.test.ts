import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect } from 'vitest'
import { VisualizationStore } from '../src/server/store'
import {
  validateVisualizationInput,
  validateVisualizationState,
  visualizationReferences,
  projectBranchVisualizations,
  type SaveVisualizationInput,
  type VisualizationState,
} from '@pi-meme/contracts/visualize'

const input: SaveVisualizationInput = {
  title: '状态预览',
  description: '按钮只切换模拟状态',
  html: '<button>跳过</button>',
  initialState: { stage: 'ready', compact: false, spacing: 4, accent: '#123456' },
  controls: [
    {
      type: 'select',
      key: 'stage',
      label: '状态',
      options: [
        { label: '等待', value: 'ready' },
        { label: '跳过', value: 'skipped' },
      ],
    },
    { type: 'toggle', key: 'compact', label: '紧凑' },
    { type: 'slider', key: 'spacing', label: '间距', min: 0, max: 10, step: 2 },
    { type: 'color', key: 'accent', label: '颜色' },
  ],
}
test('保存版本、重试幂等、重启读取、分支授权与版本冲突', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'visualize-'))
  try {
    const store = new VisualizationStore(directory)
    const first = await store.save(input, 'run:call', [], () => {})
    expect((await store.save(input, 'run:call', [], () => {})).id).toBe(first.id)
    await expect(store.read(first, [])).rejects.toThrow('不可访问')
    expect(await new VisualizationStore(directory).read(first, [first])).toEqual(first)
    const next = await store.save({ ...input, reference: first }, 'run:call2', [first], () => {})
    expect(next.revision).toBe(2)
    await expect(store.save({ ...input, reference: first }, 'run:call3', [first, next], () => {})).rejects.toThrow(
      '版本已更新',
    )
    expect((await store.read(first, [first, next])).revision).toBe(1)
    await expect(
      store.save(input, 'cancelled', [], () => {
        throw new Error('已取消')
      }),
    ).rejects.toThrow('已取消')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('四类控件校验与未知状态键拒绝', () => {
  expect(() => validateVisualizationInput(input)).not.toThrow()
  const patches: VisualizationState[] = [
    { stage: 'unknown' },
    { compact: 'yes' },
    { spacing: 3 },
    { accent: 'red' },
    { extra: true },
  ]
  for (const patch of patches) {
    expect(() => validateVisualizationState({ ...input.initialState, ...patch }, input)).toThrow()
  }
  expect(() => validateVisualizationInput({ ...input, controls: [...input.controls, input.controls[0]] })).toThrow()
  expect(() => validateVisualizationInput({ ...input, html: '中'.repeat(400000) })).toThrow()
})
test('仅投影成功工具结果，普通文本和失败结果不能授权', () => {
  const ref = { id: '12345678-1234-1234-1234-123456789012', revision: 1 }
  const message = { role: 'toolResult', toolName: 'save_visualization', details: { visualization: ref } }
  expect(visualizationReferences([message, { ...message, isError: true }, { ...message, role: 'user' }])).toEqual([ref])
})

test('分支切换与复制会话只保留祖先草图引用', () => {
  const first = { id: '12345678-1234-1234-1234-123456789012', revision: 1 }
  const second = { ...first, revision: 2 }
  const entry = (id: string, parentId: string | null, reference: typeof first) => ({
    id,
    parentId,
    type: 'message',
    message: { role: 'toolResult', toolName: 'save_visualization', details: { visualization: reference } },
  })
  const entries = [entry('a', null, first), entry('b', 'a', second), { id: 'c', parentId: 'a', type: 'compaction' }]
  expect(projectBranchVisualizations(entries, 'b')).toEqual([first, second])
  expect(projectBranchVisualizations(entries, 'c')).toEqual([first])
  expect(projectBranchVisualizations(structuredClone(entries.slice(0, 1)), 'a')).toEqual([first])
  expect(projectBranchVisualizations(entries, null)).toEqual([])
})
test('状态大小按 UTF-8 字节限制', () => {
  expect(() =>
    validateVisualizationInput({ ...input, initialState: { ...input.initialState, note: '中'.repeat(6000) } }),
  ).toThrow('16 KiB')
})
