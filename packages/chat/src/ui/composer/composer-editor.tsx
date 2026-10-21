import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import type { AgentPluginOption, ComposerProps } from './composer'
import { useCommandCompletion } from './use-command-completion'
import { FileSuggestions } from './file-suggestions'
import { CommandSuggestions } from './command-suggestions'
import { SessionNamePanel } from './session-name-panel'
import { completionQuery } from './completion-query'
import { skillMarker } from '@pi-meme/contracts/skills'
import { cn } from '@pi-meme/ui/lib/utils'
import { editorCaret, editorSelection, readEditorText, setEditorCaret, setEditorSelection } from './rich-draft'
import { adjacentPluginToken, editorPluginPositions, movePluginPositions } from './editor-plugin-tokens'
import { applyEditorTransaction, editorDraftNodes, editorMatchesDraft } from './composer-editor-transaction'
import type { ComposerDraftData } from './composer-state'

const emptyPlugins: AgentPluginOption[] = []

export function ComposerEditor({
  composerStore,
  disabled,
  sessionKey,
  agentPlugins,
  onPlanCommand,
  onGoalCommand,
  onCompact,
  sessionStarted = true,
  sessionBusy = false,
  onError,
  sessionName,
  onRenameSession,
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
  editing,
}: Pick<
  ComposerProps,
  | 'composerStore'
  | 'onPlanCommand'
  | 'onGoalCommand'
  | 'onCompact'
  | 'sessionStarted'
  | 'sessionName'
  | 'onRenameSession'
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
  sessionBusy?: boolean
  onError?: (message: string) => void
  hasQueue: boolean
  paste: (event: ClipboardEvent<HTMLDivElement>) => void
  dragging: boolean
  editing?: boolean
  /** Escape 未被命令补全或队列清空消费时触发，例如取消历史消息编辑。 */
  onEscape?: () => void
}) {
  const positions = useRef({ sessionKey, draft, offsets: new Map<string, number>() })
  const plugins = agentPlugins?.mentions ?? emptyPlugins
  const [pluginRevision, redrawPlugins] = useReducer((value: number) => value + 1, 0)
  const [naming, setNaming] = useState(false)
  const namingOpen = useRef(false)
  namingOpen.current = naming
  useEffect(() => setNaming(false), [sessionKey])
  useEffect(() => {
    if (!sessionStarted || sessionBusy) setNaming(false)
  }, [sessionStarted, sessionBusy])
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
    composerStore,
    onPlanCommand,
    onGoalCommand,
    onCompact,
    onNameCommand: onRenameSession
      ? () => {
          if (sessionBusy) {
            onError?.('Pi 正在运行或切换，请等待完成后重试')
            return
          }
          setNaming(true)
        }
      : undefined,
    sessionStarted,
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
    onPluginPosition: (id, offset) => {
      positions.current.offsets.set(id, offset)
      composerStore?.setPluginAnchors(Object.fromEntries(positions.current.offsets))
    },
    commands,
    focusVersion,
    onClearQueue,
    hasQueue,
    editing,
  })
  const composing = useRef(false)
  const nativeEdit = useRef(false)
  const pluginOptions = useRef(plugins)
  pluginOptions.current = plugins

  function acceptInput() {
    const element = editor.current
    if (!element || composing.current || nativeEdit.current) return
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
      const skill = [...selectedSkills, ...commands].find(
        (entry) =>
          (entry.resourceId ?? entry.name) === token.dataset.skillToken &&
          (token.dataset.skillRevision === undefined || (entry.resourceRevision ?? '') === token.dataset.skillRevision),
      )
      return skill ? [skill] : []
    })
    if (
      !composerStore &&
      (skills.length !== selectedSkills.length || skills.some((skill, index) => skill !== selectedSkills[index]))
    )
      onSkills(skills)
    if (composerStore)
      composerStore.patch({
        draft: text,
        selectedSkills:
          skills.length === selectedSkills.length && skills.every((skill, index) => skill === selectedSkills[index])
            ? selectedSkills
            : skills,
        pluginAnchors: Object.fromEntries(presentPlugins),
      })
    else onDraft(text)
    composerStore?.setSelection(editorSelection(element))
    const caret = editorCaret(element)
    setDraftCaret(caret)
    if (namingOpen.current && completionQuery(text, caret)?.kind === 'command') setNaming(false)
    setSuggestionsOpen(true)
  }

  useLayoutEffect(() => {
    const element = editor.current
    if (!element || composing.current) return
    if (positions.current.sessionKey !== sessionKey) positions.current = { sessionKey, draft, offsets: new Map() }
    if (composerStore) positions.current.offsets = new Map(Object.entries(composerStore.getSnapshot().pluginAnchors))
    else movePluginPositions(positions.current.offsets, positions.current.draft, draft)
    const value: ComposerDraftData = {
      draft,
      selectedSkills,
      pluginMentions: plugins.map((plugin) => plugin.id),
      pluginAnchors: Object.fromEntries(positions.current.offsets),
      attachments: [],
      queueMode: 'followUp',
    }
    positions.current.draft = draft
    if (editorMatchesDraft(element, value)) return
    const focused = document.activeElement === element
    const caret = editorCaret(element)
    element.replaceChildren(...editorDraftNodes(value, plugins))
    if (focused) setEditorCaret(element, Math.min(caret, draft.length))
  }, [draft, selectedSkills, plugins, sessionKey, pluginRevision, editor])

  useLayoutEffect(() => {
    if (!composerStore) return
    const bound = {
      focus: (selection?: { anchor: number; focus: number }) => {
        if (!editor.current || composing.current) return
        editor.current.focus()
        if (selection) setEditorSelection(editor.current, selection)
      },
      applyEdit: (next: ComposerDraftData, selection?: { anchor: number; focus: number }) => {
        const element = editor.current
        if (
          !element?.isConnected ||
          composing.current ||
          nativeEdit.current ||
          element.getAttribute('contenteditable') === 'false'
        )
          throw new Error('当前输入框不可执行编辑事务')
        nativeEdit.current = true
        try {
          return applyEditorTransaction(element, composerStore.getSnapshot(), next, pluginOptions.current, selection)
        } finally {
          nativeEdit.current = false
        }
      },
    }
    composerStore.editor = bound
    return () => {
      if (composerStore.editor === bound) composerStore.editor = null
    }
  }, [composerStore, editor, sessionKey])

  function updateSelection() {
    updateCaret()
    if (editor.current) composerStore?.setSelection(editorSelection(editor.current))
  }

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
      {naming && onRenameSession && (
        <SessionNamePanel
          sessionName={sessionName}
          onRename={onRenameSession}
          onClose={() => {
            setNaming(false)
            editor.current?.focus()
          }}
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
        key={sessionKey}
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
          composerStore?.setComposing(true)
        }}
        onCompositionEnd={() => {
          composing.current = false
          composerStore?.setComposing(false)
          acceptInput()
        }}
        onKeyUp={updateSelection}
        onMouseUp={updateSelection}
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
            const skills = selectedSkills.filter((_, skillIndex) => skillIndex !== index)
            const text = draft.slice(0, tokenIndex) + draft.slice(tokenIndex + 1)
            if (composerStore) composerStore.patch({ selectedSkills: skills, draft: text })
            else {
              onSkills(skills)
              onDraft(text)
            }
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
