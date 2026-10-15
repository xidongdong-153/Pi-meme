import { useEffect, useState } from 'react'
import { type HighlighterCore, createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

let instance: HighlighterCore | null = null
let pending: Promise<HighlighterCore> | null = null

export async function getHighlighter(): Promise<HighlighterCore> {
  if (instance) return instance
  if (!pending) {
    pending = createHighlighterCore({
      engine: createOnigurumaEngine(import('shiki/wasm')),
      themes: [import('shiki/themes/github-dark-default.mjs')],
      langs: [
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/shellscript.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/rust.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/java.mjs'),
        import('shiki/langs/c.mjs'),
        import('shiki/langs/cpp.mjs'),
        import('shiki/langs/ruby.mjs'),
        import('shiki/langs/php.mjs'),
        import('shiki/langs/swift.mjs'),
        import('shiki/langs/kotlin.mjs'),
        import('shiki/langs/toml.mjs'),
        import('shiki/langs/diff.mjs'),
        import('shiki/langs/docker.mjs'),
      ],
    }).then((h) => {
      instance = h
      return h
    })
  }
  return pending
}

export function useHighlighter() {
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(instance)

  useEffect(() => {
    if (instance) {
      setHighlighter(instance)
      return
    }
    let current = true
    void getHighlighter()
      .then((value) => {
        if (current) setHighlighter(value)
      })
      .catch(() => {
        // 加载失败时继续显示代码原文。
      })
    return () => {
      current = false
    }
  }, [])

  return highlighter
}
