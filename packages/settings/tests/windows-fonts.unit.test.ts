import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseWindowsFonts } from '../src/server/fonts'

test('DirectWrite 字体按真实字重和斜体合并四种样式，保留中文家族与等宽属性', () => {
  const face = (weight: number, italic = false, monospace = false) => ({ weight, italic, monospace })
  assert.deepEqual(
    parseWindowsFonts([
      { family: '中文字体', faces: [face(400), face(700), face(400, true), face(700, true)] },
      { family: '代码字体', faces: [face(400, false, true), face(500, false, true)] },
      { family: '代码字体', faces: [face(700, false, true)] },
    ]).find((font) => font.family === '代码字体'),
    { family: '代码字体', styles: ['regular', 'bold'], monospace: true },
  )
  assert.deepEqual(
    parseWindowsFonts([{ family: '中文字体', faces: [face(400), face(700), face(400, true), face(700, true)] }])[0]
      .styles,
    ['regular', 'bold', 'italic', 'bold-italic'],
  )
})

test.each([
  null,
  {},
  [null],
  [{ family: '', faces: [] }],
  [{ family: '坏字体', faces: [{ weight: 1000, italic: false, monospace: false }] }],
])('拒绝无效 Windows 字体响应 %#', (value) => {
  assert.throws(() => parseWindowsFonts(value), /系统字体列表格式无效/)
})
