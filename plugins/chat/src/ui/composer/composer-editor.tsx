import { useLayoutEffect, useRef } from 'react'
import type { ClipboardEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import type { ComposerProps } from './composer'
import { useCommandCompletion } from './use-command-completion'
import { FileSuggestions } from './file-suggestions'
import { CommandSuggestions } from './command-suggestions'
import { skillMarker } from '@pi-meme/contracts/skills'
import { editorCaret, readEditorText, setEditorCaret } from './rich-draft'

export function ComposerEditor({
  projectPath,
  loadProjectFiles,
  selectedSkills,
  onSkills,
  draft,
  onDraft,
  commands,
  focusVersion,
  onClearQueue,
  hasQueue,
  paste,
  dragging,
  onEscape,
}: Pick<
  ComposerProps,
  | 'projectPath'
  | 'loadProjectFiles'
  | 'draft'
  | 'onDraft'
  | 'selectedSkills'
  | 'onSkills'
  | 'commands'
  | 'focusVersion'
  | 'onClearQueue'
> & {
  hasQueue: boolean
  paste: (event: ClipboardEvent<HTMLDivElement>) => void
  dragging: boolean
  /** Escape 未被命令补全或队列清空消费时触发，例如取消历史消息编辑。 */
  onEscape?: () => void
}) {
  const {
    editor,
    matches,
    fileCompletion,
    fileMatches,
    fileQuery,
    fileError,
    filesLoading,
    completeFile,
    replaceFileQuery,
    skillCompletion,
    suggestionIndex,
    completeCommand,
    keyDown,
    setDraftCaret,
    updateCaret,
    setSuggestionsOpen,
  } = useCommandCompletion({
    projectPath,
    loadProjectFiles,
    draft,
    onDraft,
    onSkills,
    selectedSkills,
    commands,
    focusVersion,
    onClearQueue,
    hasQueue,
  })
  const composing = useRef(false)
  const renderedSkill = useRef(selectedSkills)

  function acceptInput() {
    const element = editor.current
    if (!element || composing.current) return
    const text = readEditorText(element)
    const skills = [...element.querySelectorAll<HTMLElement>('[data-skill-token]')].flatMap((token) => {
      const skill = selectedSkills.find((entry) => entry.name === token.dataset.skillToken)
      return skill ? [skill] : []
    })
    if (skills.length !== selectedSkills.length || skills.some((skill, index) => skill !== selectedSkills[index]))
      onSkills(skills)
    onDraft(text)
    setDraftCaret(editorCaret(element))
    setSuggestionsOpen(true)
  }

  useLayoutEffect(() => {
    const element = editor.current
    if (!element || composing.current) return
    if (readEditorText(element) === draft && renderedSkill.current === selectedSkills) return
    const focused = document.activeElement === element
    const caret = editorCaret(element)
    const nodes: Node[] = []
    const parts = draft.split(skillMarker)
    parts.forEach((text, index) => {
      const skill = selectedSkills[index - 1]
      if (index && skill) {
        const token = document.createElement('span')
        token.dataset.skillToken = skill.name
        token.contentEditable = 'false'
        token.className = 'inline text-blue-400 select-none'
        token.setAttribute('aria-label', '已选择技能')
        token.title = skill.sourceInfo.path
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        icon.setAttribute('viewBox', '0 0 24 24')
        icon.setAttribute('fill', 'none')
        icon.setAttribute('stroke', 'currentColor')
        icon.setAttribute('stroke-width', '1.5')
        icon.setAttribute('class', 'inline-block size-4 align-[-0.125em] mr-1')
        icon.setAttribute('aria-hidden', 'true')
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', 'M12 3 3 8v10l9 5 9-5V8L12 3Zm0 10 9-5M12 13 3 8m9 5v10M7.5 5.5l9 5')
        icon.append(path)
        token.append(icon, document.createTextNode(skill.name.replace(/^skill:/, '')))
        nodes.push(token)
      }
      nodes.push(document.createTextNode(text))
    })
    element.replaceChildren(...nodes)
    renderedSkill.current = selectedSkills
    if (focused) setEditorCaret(element, Math.min(caret, draft.length))
  }, [draft, selectedSkills, editor])

  function insertText(text: string) {
    const element = editor.current
    const selection = window.getSelection()
    if (!element || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!element.contains(range.commonAncestorContainer)) return
    document.execCommand('insertText', false, text.replaceAll(skillMarker, ''))
    acceptInput()
  }

  return (
    <div className="relative w-full">
      {fileCompletion && (
        <FileSuggestions
          matches={fileMatches}
          query={fileQuery ?? ''}
          loading={filesLoading}
          error={fileError}
          suggestionIndex={suggestionIndex}
          onComplete={completeFile}
          onDirectory={replaceFileQuery}
        />
      )}
      <CommandSuggestions
        matches={matches}
        skillCompletion={skillCompletion}
        suggestionIndex={suggestionIndex}
        onComplete={completeCommand}
      />
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="combobox"
        aria-label="消息"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-expanded={fileCompletion || matches.length > 0}
        aria-controls={fileCompletion || matches.length ? 'composer-suggestions' : undefined}
        aria-activedescendant={fileMatches.length || matches.length ? `composer-option-${suggestionIndex}` : undefined}
        data-placeholder="说说你的想法"
        onInput={acceptInput}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
          acceptInput()
        }}
        onKeyUp={updateCaret}
        onMouseUp={updateCaret}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          const caret = editor.current ? editorCaret(editor.current) : 0
          const tokenIndex = event.key === 'Backspace' ? caret - 1 : event.key === 'Delete' ? caret : -1
          if (window.getSelection()?.isCollapsed && tokenIndex >= 0 && draft[tokenIndex] === skillMarker) {
            event.preventDefault()
            const index = draft.slice(0, tokenIndex).split(skillMarker).length - 1
            onSkills(selectedSkills.filter((_, skillIndex) => skillIndex !== index))
            onDraft(draft.slice(0, tokenIndex) + draft.slice(tokenIndex + 1))
            setDraftCaret(tokenIndex)
            requestAnimationFrame(() => {
              if (editor.current) setEditorCaret(editor.current, tokenIndex)
            })
            return
          }
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault()
            document.execCommand('insertLineBreak')
            acceptInput()
            return
          }
          keyDown(event)
          if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) onEscape?.()
        }}
        onPaste={(event) => {
          paste(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          insertText(event.clipboardData.getData('text/plain'))
        }}
        className="w-full min-h-[40px] max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words px-2 py-1 text-sm leading-relaxed text-foreground outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/70"
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-xs font-medium text-primary">
          <ImagePlus className="size-4 mr-1.5" />
          松开以附加图片
        </div>
      )}
    </div>
  )
}
