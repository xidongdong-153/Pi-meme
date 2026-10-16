import { test } from '../../../tests/fixtures/desktop'

test('输入框在不同宽度下保持控件可见且没有横向溢出', async ({ desktop }) => {
  await desktop.runNative('composer-layout')
})

test('真实图片预览支持缩放、键盘切图和焦点恢复', async ({ desktop }) => {
  await desktop.runNative('image-viewer')
})
