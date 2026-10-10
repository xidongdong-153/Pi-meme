import { useEffect, useState } from 'react'
import { type Highlighter, createHighlighter } from 'shiki'

let instance: Highlighter | null = null
let pending: Promise<Highlighter> | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (instance) return instance
  if (!pending) {
    pending = createHighlighter({
      themes: ['github-dark-default'],
      langs: [
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
      ],
    }).then((h) => {
      instance = h
      return h
    })
  }
  return pending
}

export function useHighlighter() {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(instance)

  useEffect(() => {
    if (instance) {
      setHighlighter(instance)
      return
    }
    getHighlighter().then(setHighlighter)
  }, [])

  return highlighter
}
