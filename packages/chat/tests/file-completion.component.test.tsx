import assert from 'node:assert/strict'
import { useState } from 'react'
import { afterEach, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { builtinCommands, type PiMessage } from '@pi-meme/contracts/pi'
import type { ChatBridge, ProjectFile } from '@pi-meme/contracts/desktop'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { ComposerEditor } from '../src/ui/composer/composer-editor'
import {
  editorCaret,
  editorSelection,
  readEditorText,
  setEditorCaret,
  setEditorSelection,
} from '../src/ui/composer/rich-draft'
import { ComposerDraftStore } from '../src/ui/composer/composer-state'
import { applyEditorTransaction, editorDraftNodes } from '../src/ui/composer/composer-editor-transaction'
import { applyComposerSteps } from '../src/ui/composer/composer-document'
import { ChatMessage } from '../src/ui/conversation/chat-message'

afterEach(cleanup)

function fixture(initial = '', files: ProjectFile[] = [{ path: 'src/main.ts', kind: 'file' }]) {
  const loadFiles = vi.fn<ChatBridge['getProjectFiles']>(async () => files)
  let draft = initial
  function Page() {
    const [value, setValue] = useState(initial)
    draft = value
    return (
      <TooltipProvider>
        <ComposerEditor
          sessionKey="test"
          draft={value}
          onDraft={setValue}
          selectedSkills={[]}
          onSkills={() => {}}
          commands={builtinCommands}
          projectPath="/project"
          loadProjectFiles={loadFiles}
          focusVersion={0}
          onClearQueue={() => {}}
          hasQueue={false}
          paste={() => {}}
          dragging={false}
        />
      </TooltipProvider>
    )
  }
  const view = render(<Page />)
  const editor = view.getByRole('combobox', { name: '消息' })
  editor.focus()
  function input(text: string, caret = text.length) {
    editor.replaceChildren(document.createTextNode(text))
    setEditorCaret(editor, caret)
    fireEvent.input(editor)
  }
  return { ...view, editor, input, loadFiles, draft: () => draft }
}

test('在文件引用前组合输入中文时，不用未同步草稿重新触发文件补全', () => {
  const page = fixture('前文\n@src/main.ts ')
  setEditorCaret(page.editor, 2)
  fireEvent.mouseUp(page.editor)
  assert.ok(!page.queryByRole('listbox'))
  fireEvent.compositionStart(page.editor)
  page.editor.firstChild!.textContent = '前文正在输入中文\n@src/main.ts '
  setEditorCaret(page.editor, 7)
  fireEvent.input(page.editor, { isComposing: true })
  fireEvent.keyUp(page.editor, { key: 'n', isComposing: true })
  assert.ok(!page.queryByRole('listbox'))
  assert.equal(page.draft(), '前文\n@src/main.ts ')
  fireEvent.compositionEnd(page.editor)
  assert.ok(!page.queryByRole('listbox'))
  assert.equal(page.draft(), '前文正在输入中文\n@src/main.ts ')
})

test.each([
  { path: 'src/main.ts', kind: 'file' as const },
  { path: 'docs/中文 文件.md', kind: 'file' as const },
  { path: 'src/components', kind: 'directory' as const },
])('选中 $path 后显示独立引用，正文和复制保留完整路径', async (file) => {
  const page = fixture('', [file])
  page.input('前文 @ 后文', 4)
  fireEvent.click(await page.findByRole('option'))
  const path = file.path + (file.kind === 'directory' ? '/' : '')
  const reference = `@"${path}"`
  const token = page.editor.querySelector<HTMLElement>('[data-file-token]')
  assert.ok(token)
  assert.equal(token.getAttribute('contenteditable'), 'false')
  assert.equal(token.title, path)
  assert.equal(page.draft(), `前文 ${reference}  后文`)
  assert.equal(readEditorText(page.editor), page.draft())
  assert.equal(page.queryByRole('listbox'), null)
  const range = document.createRange()
  range.selectNode(token)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  const setData = vi.fn()
  fireEvent.copy(page.editor, { clipboardData: { setData } })
  assert.deepEqual(setData.mock.calls, [['text/plain', reference]])
  setEditorCaret(page.editor, 3 + reference.length)
  fireEvent.keyDown(page.editor, { key: 'Backspace' })
  assert.equal(page.draft(), '前文   后文')
  assert.equal(page.editor.querySelector('[data-file-token]'), null)
})

test('目录 Tab 继续补全，Enter 才完成引用，引用前后仍可继续输入', async () => {
  const page = fixture('', [{ path: 'src', kind: 'directory' }])
  page.input('@')
  await page.findByRole('option')
  fireEvent.keyDown(page.editor, { key: 'Tab' })
  assert.equal(page.draft(), '@src/')
  assert.equal(page.editor.querySelector('[data-file-token]'), null)
  await waitFor(() => assert.equal(page.loadFiles.mock.calls.at(-1)?.[1], 'src/'))
  fireEvent.keyDown(page.editor, { key: 'Enter' })
  assert.equal(page.draft(), '@"src/" ')
  assert.ok(page.editor.querySelector('[data-file-token]'))
  await act(async () => new Promise(requestAnimationFrame))
  assert.equal(editorCaret(page.editor), page.draft().length)
  const text = document.createTextNode('前文\n')
  page.editor.prepend(text)
  setEditorCaret(page.editor, text.length)
  fireEvent.input(page.editor)
  assert.equal(page.draft(), '前文\n@"src/" ')
  assert.equal(page.queryByRole('listbox'), null)
})

test('文件引用恢复后仍按完整正文偏移提供选区，插件事务可精确修改路径', () => {
  const store = new ComposerDraftStore()
  store.setDraft('前文 @"src/main.ts" 后文')
  const before = store.getSnapshot()
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.replaceChildren(...editorDraftNodes(before, []))
  document.body.append(editor)
  editor.focus()
  setEditorSelection(editor, { anchor: 3, focus: 17 })
  assert.deepEqual(editorSelection(editor), { anchor: 3, focus: 17 })
  const from = before.draft.indexOf('main')
  const next = {
    ...before,
    ...applyComposerSteps(
      before,
      [{ kind: 'replace', from, to: from + 4, content: [{ kind: 'text', text: 'app' }] }],
      [],
    ),
  }
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string, _showUi: boolean, text: string) => {
      assert.equal(command, 'insertHTML')
      const range = window.getSelection()!.getRangeAt(0)
      assert.equal(readEditorText(range.cloneContents()), '@"src/main.ts"')
      range.deleteContents()
      range.insertNode(range.createContextualFragment(text))
      return true
    },
  })
  try {
    applyEditorTransaction(editor, before, next, [])
    assert.equal(readEditorText(editor), '前文 @"src/app.ts" 后文')
    editor.replaceChildren(...editorDraftNodes(next, []))
    assert.equal(editor.querySelector<HTMLElement>('[data-file-token]')?.title, 'src/app.ts')
  } finally {
    if (previous) Object.defineProperty(document, 'execCommand', previous)
    else Reflect.deleteProperty(document, 'execCommand')
    editor.remove()
  }
})

test('用户消息沿用输入框的文件引用，复制与编辑仍保留完整路径和正文', async () => {
  const user = userEvent.setup()
  const text = '@"docs/中文 文件.md" 看看这个\n再看 @"src/components/"'
  const page = fixture(text)
  const onEdit = vi.fn()
  const message: PiMessage = {
    role: 'user',
    content: text,
    timestamp: 1,
    sourceEntry: { id: 'entry', type: 'message', revision: '1' },
  }
  const view = render(
    <TooltipProvider>
      <ChatMessage message={message} tools={{}} onEdit={onEdit} canEdit />
    </TooltipProvider>,
  )
  for (const token of page.editor.querySelectorAll<HTMLElement>('[data-file-token]')) {
    const reference = within(view.container).getByLabelText(token.getAttribute('aria-label')!)
    assert.equal(reference.textContent, token.textContent)
    assert.equal(reference.title, token.title)
    assert.equal(reference.querySelector('use')?.getAttribute('href'), token.querySelector('use')?.getAttribute('href'))
  }
  const body = view.container.querySelector('[data-message-body]')!
  assert.equal(body.textContent, '中文 文件.md 看看这个\n再看 components/')
  await user.click(within(view.container).getByRole('button', { name: '复制消息' }))
  assert.equal(await navigator.clipboard.readText(), text)
  await user.click(within(view.container).getByRole('button', { name: '编辑消息' }))
  assert.equal(onEdit.mock.calls[0][0], message)
  assert.equal(readEditorText(page.editor), text)
})
