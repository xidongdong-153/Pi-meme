import { useLayoutEffect, useReducer, useRef } from 'react'
import type { ClipboardEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import type { AgentPluginOption, ComposerProps } from './composer'
import { useCommandCompletion } from './use-command-completion'
import { FileSuggestions } from './file-suggestions'
import { CommandSuggestions } from './command-suggestions'
import { skillMarker } from '@pi-meme/contracts/skills'
import { cn } from '@pi-meme/ui/lib/utils'
import { editorCaret, readEditorText, setEditorCaret } from './rich-draft'
import {
  adjacentPluginToken,
  createEditorToken,
  editorPluginPositions,
  movePluginPositions,
} from './editor-plugin-tokens'

const emptyPlugins: AgentPluginOption[] = []

export function ComposerEditor({
  disabled,
  sessionKey,
  agentPlugins,
  onPlanCommand,
  projectPath,
  loadProjectFiles,
  selectedSkills,
  onSkills,
  draft,
  onDraft,
  hint,
  onAcceptHint,
  onDismissHint,
  commands,
  focusVersion,
  onClearQueue,
  hasQueue,
  paste,
  dragging,
  onEscape,
}: Pick<
  ComposerProps,
  | 'onPlanCommand'
  | 'sessionKey'
  | 'agentPlugins'
  | 'projectPath'
  | 'loadProjectFiles'
  | 'draft'
  | 'onDraft'
  | 'hint'
  | 'onAcceptHint'
  | 'onDismissHint'
  | 'selectedSkills'
  | 'onSkills'
  | 'commands'
  | 'focusVersion'
  | 'onClearQueue'
> & {
  disabled?: boolean
  hasQueue: boolean
  paste: (event: ClipboardEvent<HTMLDivElement>) => void
  dragging: boolean
  /** Escape 未被命令补全或队列清空消费时触发，例如取消历史消息编辑。 */
  onEscape?: () => void
}) {
  const positions = useRef({ sessionKey, draft, offsets: new Map<string, number>() })
  const plugins = agentPlugins?.mentions ?? emptyPlugins
  const [pluginRevision, redrawPlugins] = useReducer((value: number) => value + 1, 0)
  const {
    editor,
    matches,
    commandCompletion,
    fileCompletion,
    fileMatches,
    fileQuery,
    fileError,
    filesLoading,
    completeFile,
    replaceFileQuery,
    skillCompletion,
    suggestionIndex,
    completeItem,
    keyDown,
    setDraftCaret,
    updateCaret,
    setSuggestionsOpen,
  } = useCommandCompletion({
    onPlanCommand,
    projectPath,
    loadProjectFiles,
    draft,
    onDraft,
    hint,
    onAcceptHint,
    onDismissHint,
    onSkills,
    selectedSkills,
    agentPlugins,
    onPluginPosition: (id, offset) => positions.current.offsets.set(id, offset),
    commands,
    focusVersion,
    onClearQueue,
    hasQueue,
  })
  const composing = useRef(false)
  const renderedSkill = useRef(selectedSkills)
  const renderedPlugins = useRef(plugins)

  function acceptInput() {
    const element = editor.current
    if (!element || composing.current) return
    const text = readEditorText(element)
    movePluginPositions(positions.current.offsets, positions.current.draft, text)
    positions.current.draft = text
    const presentPlugins = editorPluginPositions(element)
    for (const [id, offset] of presentPlugins) positions.current.offsets.set(id, offset)
    if (plugins.some((plugin) => !presentPlugins.has(plugin.id))) {
      if (!disabled && agentPlugins && !agentPlugins.disabledReason)
        void agentPlugins.change(
          agentPlugins.selected
            .filter((plugin) => !plugins.some((mention) => mention.id === plugin.id && !presentPlugins.has(plugin.id)))
            .map((plugin) => plugin.id),
        )
      redrawPlugins()
    }
    const skills = [...element.querySelectorAll<HTMLElement>('[data-skill-token]')].flatMap((token) => {
      const skill = selectedSkills.find((entry) => (entry.resourceId ?? entry.name) === token.dataset.skillToken)
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
    if (positions.current.sessionKey !== sessionKey) positions.current = { sessionKey, draft, offsets: new Map() }
    const presentPlugins = editorPluginPositions(element)
    if (
      readEditorText(element) === draft &&
      renderedSkill.current === selectedSkills &&
      renderedPlugins.current === plugins &&
      presentPlugins.size === plugins.length &&
      plugins.every((plugin) => presentPlugins.has(plugin.id))
    )
      return
    const focused = document.activeElement === element
    const caret = editorCaret(element)
    movePluginPositions(positions.current.offsets, positions.current.draft, draft)
    positions.current.draft = draft
    const mentions: Array<{ offset: number; length: number; node: Node }> = plugins.map((plugin) => ({
      offset: Math.min(positions.current.offsets.get(plugin.id) ?? 0, draft.length),
      length: 0,
      node: createEditorToken('plugin', plugin.id, plugin.name, plugin.description, plugin.iconUrl),
    }))
    let skillIndex = 0
    for (let offset = 0; offset < draft.length; offset++) {
      if (draft[offset] !== skillMarker) continue
      const skill = selectedSkills[skillIndex++]
      if (skill)
        mentions.push({
          offset,
          length: 1,
          node: createEditorToken(
            'skill',
            skill.resourceId ?? skill.name,
            skill.displayName ?? skill.name.replace(/^skill:/, ''),
            skill.sourceInfo.path,
          ),
        })
    }
    mentions.sort((left, right) => left.offset - right.offset || left.length - right.length)
    const nodes: Node[] = []
    let offset = 0
    for (const mention of mentions) {
      nodes.push(document.createTextNode(draft.slice(offset, mention.offset)), mention.node)
      offset = mention.offset + mention.length
    }
    nodes.push(document.createTextNode(draft.slice(offset)))
    element.replaceChildren(...nodes)
    renderedSkill.current = selectedSkills
    renderedPlugins.current = plugins
    if (focused) setEditorCaret(element, Math.min(caret, draft.length))
  }, [draft, selectedSkills, plugins, sessionKey, pluginRevision, editor])

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
    <div className="composer-editor relative w-full">
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
      {commandCompletion && (
        <CommandSuggestions
          matches={matches}
          skillCompletion={skillCompletion}
          agentPlugins={agentPlugins}
          suggestionIndex={suggestionIndex}
          onComplete={completeItem}
        />
      )}
      <div
        ref={editor}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="combobox"
        aria-label="消息"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-expanded={fileCompletion || commandCompletion}
        aria-controls={fileCompletion || commandCompletion ? 'composer-suggestions' : undefined}
        aria-activedescendant={
          suggestionIndex >= 0 && (fileMatches.length || matches.length)
            ? `composer-option-${suggestionIndex}`
            : undefined
        }
        data-placeholder={hint || '说说你的想法'}
        aria-describedby={hint ? 'composer-next-step' : undefined}
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
        onBlur={() => setSuggestionsOpen(false)}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          const caret = editor.current ? editorCaret(editor.current) : 0
          if (editor.current && (event.key === 'Backspace' || event.key === 'Delete')) {
            const plugin = adjacentPluginToken(editor.current, event.key === 'Backspace')
            if (plugin) {
              event.preventDefault()
              if (!disabled && agentPlugins && !agentPlugins.disabledReason)
                void agentPlugins.change(
                  agentPlugins.selected
                    .filter((entry) => entry.id !== plugin.dataset.pluginToken)
                    .map((entry) => entry.id),
                )
              return
            }
          }
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
          if (!disabled && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing)
            onEscape?.()
        }}
        onPaste={(event) => {
          paste(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          insertText(event.clipboardData.getData('text/plain'))
        }}
        className={cn(
          'composer-draft w-full min-h-[40px] max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words px-2 py-1 text-sm leading-relaxed text-foreground outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/70',
          hint && 'pr-10',
        )}
      />
      {hint && (
        <>
          <span id="composer-next-step" className="sr-only">
            按 Tab 填入：{hint}
          </span>
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 rounded border border-border/70 px-1 text-[10px] leading-4 text-muted-foreground/70"
          >
            Tab
          </span>
        </>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-xs font-medium text-primary">
          <ImagePlus className="size-4 mr-1.5" />
          松开以附加图片
        </div>
      )}
    </div>
  )
}
