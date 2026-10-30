import assert from 'node:assert/strict'
import { test } from 'vitest'
import { getHighlighter, normalizeCodeLanguage } from '@pi-meme/ui/lib/use-highlighter'

test('高亮器并发加载复用实例，代表语言及别名支持明暗主题', async () => {
  const [first, second] = await Promise.all([getHighlighter(), getHighlighter()])
  assert.equal(first, second)
  for (const language of ['TS', 'c++', 'shell']) {
    const html = first.codeToHtml('const value = 1', {
      lang: normalizeCodeLanguage(language),
      themes: { light: 'github-light-default', dark: 'github-dark-default' },
      defaultColor: 'light-dark()',
    })
    assert.match(html, /light-dark\(/)
    assert.match(html, /<span[^>]*style=/)
  }
})
