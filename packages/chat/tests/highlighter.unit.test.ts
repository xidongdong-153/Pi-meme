import assert from 'node:assert/strict'
import { test } from 'vitest'
import { getHighlighter } from '../src/ui/content/use-highlighter'

test('按需构建的高亮器保留原有语言、别名和主题，并共享同一实例', async () => {
  const [first, second] = await Promise.all([getHighlighter(), getHighlighter()])
  assert.equal(first, second)
  for (const lang of [
    'javascript',
    'typescript',
    'tsx',
    'jsx',
    'python',
    'html',
    'css',
    'json',
    'markdown',
    'bash',
    'shellscript',
    'yaml',
    'sql',
    'rust',
    'go',
    'java',
    'c',
    'cpp',
    'ruby',
    'php',
    'swift',
    'kotlin',
    'toml',
    'diff',
    'dockerfile',
  ]) {
    assert.match(first.codeToHtml('const value = 1', { lang, theme: 'github-dark-default' }), /<pre[^>]*shiki/)
  }
})
