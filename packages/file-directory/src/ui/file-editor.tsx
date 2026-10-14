import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { EditorState, type Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const colors = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.number, tags.bool, tags.null],
      color: 'var(--primary)',
    },
    { tag: [tags.string, tags.regexp], color: 'var(--color-success)' },
    { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)', fontStyle: 'italic' },
    { tag: [tags.variableName, tags.propertyName, tags.typeName], color: 'var(--foreground)' },
  ]),
)

function language(path: string): Extension {
  const ext = path.split('.').at(-1)?.toLowerCase()
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext ?? ''))
    return javascript({ typescript: ['ts', 'tsx', 'mts', 'cts'].includes(ext!), jsx: ['jsx', 'tsx'].includes(ext!) })
  if (ext === 'json') return json()
  if (['md', 'markdown', 'mdx'].includes(ext ?? '')) return markdown()
  if (ext === 'html') return html()
  if (['css', 'scss'].includes(ext ?? '')) return css()
  return []
}
export function FileEditor({
  path,
  content,
  editable,
  onChange,
}: {
  path: string
  content: string
  editable: boolean
  onChange: (value: string) => void
}) {
  const parent = useRef<HTMLDivElement>(null)
  const change = useRef(onChange)
  change.current = onChange
  const initial = useRef(content)
  useEffect(() => {
    if (!parent.current) return
    const view = new EditorView({
      parent: parent.current,
      doc: initial.current,
      extensions: [
        basicSetup,
        colors,
        language(path),
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
        EditorView.contentAttributes.of({ 'aria-label': `文件编辑器：${path}`, spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) change.current(update.state.doc.toString())
        }),
      ],
    })
    return () => view.destroy()
  }, [path, editable])
  return <div ref={parent} className="file-editor min-h-0 flex-1 overflow-hidden" />
}
