import { goalCommands } from '@pi-meme/contracts/goal'
import { planCompletion } from './plan-input'
import * as React from 'react'
import type { ProjectFile } from '@pi-meme/contracts/desktop'
import type { KeyboardEvent } from 'react'
import type { AgentPluginOption, ComposerProps } from './composer'
import { editorCaret, setEditorCaret } from './rich-draft'
import { skillMarker } from '@pi-meme/contracts/skills'
import { completionQuery } from './completion-query'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

export type CompletionItem =
  { kind: 'command' | 'skill'; command: PiSlashCommand } | { kind: 'plugin'; plugin: AgentPluginOption }

export function useCommandCompletion({
  composerStore,
  onPlanCommand,
  onGoalCommand,
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
  onPluginPosition,
  commands,
  focusVersion,
  editing,
}: Pick<
  ComposerProps,
  | 'composerStore'
  | 'onPlanCommand'
  | 'onGoalCommand'
  | 'projectPath'
  | 'loadProjectFiles'
  | 'draft'
  | 'onDraft'
  | 'hint'
  | 'onAcceptHint'
  | 'onDismissHint'
  | 'onSkills'
  | 'selectedSkills'
  | 'agentPlugins'
  | 'commands'
  | 'focusVersion'
  | 'onClearQueue'
> & {
  hasQueue: boolean
  onPluginPosition?: (id: string, offset: number) => void
  editing?: boolean
}) {
  const editor = React.useRef<HTMLDivElement>(null)
  const previousFocusVersion = React.useRef(focusVersion)
  const completionCaret = React.useRef<number | null>(null)
  const draftValue = React.useRef(draft)
  draftValue.current = draft
  const [suggestionIndex, setSuggestionIndex] = React.useState(0)
  const [suggestionsOpen, setSuggestionsOpen] = React.useState(true)
  const [draftCaret, setDraftCaret] = React.useState(draft.length)

  React.useEffect(() => {
    if (previousFocusVersion.current === focusVersion) return
    previousFocusVersion.current = focusVersion
    editor.current?.focus()
    if (editor.current) setEditorCaret(editor.current, draftValue.current.length)
  }, [focusVersion])

  const query = completionQuery(draft, draftCaret)
  const fileCompletion = suggestionsOpen && query?.kind === 'file' && Boolean(projectPath && loadProjectFiles)
  const fileQuery = query?.kind === 'file' ? query.query : undefined
  const [fileResult, setFileResult] = React.useState<{
    path?: string
    query?: string
    entries: ProjectFile[]
    error?: string
  }>({ entries: [] })
  const currentFiles = fileResult.path === projectPath && fileResult.query === fileQuery
  const fileMatches = fileCompletion && currentFiles ? fileResult.entries : []
  const fileError = currentFiles ? fileResult.error : undefined
  React.useEffect(() => {
    if (!fileCompletion || !projectPath || fileQuery === undefined || !loadProjectFiles) return
    let cancelled = false
    const timer = setTimeout(() => {
      void loadProjectFiles(projectPath, fileQuery).then(
        (entries) => {
          if (!cancelled) setFileResult({ path: projectPath, query: fileQuery, entries })
        },
        (error: unknown) => {
          if (!cancelled)
            setFileResult({
              path: projectPath,
              query: fileQuery,
              entries: [],
              error: `无法读取项目文件：${String(error)}`,
            })
        },
      )
    }, 100)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fileCompletion, projectPath, fileQuery, loadProjectFiles])
  const skillCompletion = query?.kind === 'skill'
  const commandCompletion = suggestionsOpen && Boolean(query && query.kind !== 'file')
  const commandStart = query?.kind === 'command' && !draft.slice(0, query.start).trim()
  const matches = React.useMemo<CompletionItem[]>(() => {
    if (!suggestionsOpen || !query || query.kind === 'file') return []
    const prefix = query.query.toLowerCase()
    const skills: CompletionItem[] = commands
      .filter(
        (command) =>
          command.source === 'skill' &&
          (command.name
            .replace(/^skill:/, '')
            .toLowerCase()
            .includes(prefix.replace(/^skill:/, '')) ||
            command.displayName?.toLowerCase().includes(prefix) ||
            command.shortDescription?.toLowerCase().includes(prefix) ||
            command.description?.toLowerCase().includes(prefix)),
      )
      .map((command) => ({ kind: 'skill', command }))
    if (query.kind === 'skill') return skills
    const canonicalPlan = commands.find((command) => command.source === 'builtin' && command.name === 'plan')
    let planSeen = false
    const top =
      commandStart && !editing
        ? commands.flatMap<CompletionItem>((command) => {
            if (command.source === 'skill') return []
            const plan = command.source === 'builtin' && ['plan', '计划', '计划模式'].includes(command.name)
            if (plan && planSeen) return []
            if (plan) planSeen = true
            const preferred = plan ? (canonicalPlan ?? command) : command
            const candidate = plan && preferred.name !== 'plan' ? { ...preferred, name: 'plan' } : preferred
            return candidate.name.toLowerCase().startsWith(prefix) ||
              (plan && '计划模式'.startsWith(prefix)) ||
              (candidate.source === 'builtin' &&
                candidate.name === 'goal' &&
                ['目标', '目标模式'].some((name) => name.startsWith(prefix)))
              ? [{ kind: 'command', command: candidate }]
              : []
          })
        : []
    top.sort(
      (left, right) =>
        Number(right.kind !== 'plugin' && right.command.source === 'builtin') -
        Number(left.kind !== 'plugin' && left.command.source === 'builtin'),
    )
    const plugins: CompletionItem[] = (agentPlugins?.options ?? [])
      .filter((plugin) =>
        [plugin.id, plugin.name, plugin.description].some((value) => value?.toLowerCase().includes(prefix)),
      )
      .map((plugin) => ({ kind: 'plugin', plugin }))
    return [...top, ...skills, ...plugins]
  }, [commands, commandStart, editing, query?.kind, query?.query, suggestionsOpen, agentPlugins?.options])
  const selectable = matches.flatMap((item, index) =>
    item.kind === 'plugin' && agentPlugins?.disabledReason ? [] : [index],
  )
  const matchCount = fileCompletion ? fileMatches.length : selectable.length
  const activeIndex = fileCompletion
    ? Math.min(suggestionIndex, Math.max(0, matchCount - 1))
    : (selectable[Math.min(suggestionIndex, Math.max(0, matchCount - 1))] ?? -1)

  React.useEffect(() => setSuggestionIndex(0), [query?.kind, query?.query, projectPath])
  React.useEffect(() => {
    document.getElementById(`composer-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, matchCount])

  function completeItem(item: CompletionItem) {
    if (!query) return
    if (item.kind === 'plugin') {
      if (!agentPlugins || agentPlugins.disabledReason) return
      const { id } = item.plugin
      if (!agentPlugins.mentions.some((plugin) => plugin.id === id)) onPluginPosition?.(id, query.start)
      replaceQuery('')
      void agentPlugins.select(id)
      return
    }
    const command = item.command
    if (
      item.kind === 'command' &&
      command.source === 'builtin' &&
      (goalCommands as readonly string[]).includes(command.name) &&
      onGoalCommand &&
      query.start === draft.search(/\S/u)
    ) {
      onGoalCommand(`/goal ${draft.slice(draftCaret).trimStart()}`)
      setSuggestionsOpen(false)
      editor.current?.focus()
      return
    }
    const plan = item.kind === 'command' ? planCompletion(command, draft, query.start, draftCaret) : undefined
    if (plan !== undefined && onPlanCommand) {
      onPlanCommand(plan)
      completionCaret.current = 0
      setDraftCaret(0)
      setSuggestionsOpen(false)
      editor.current?.focus()
      requestAnimationFrame(() => {
        if (editor.current) setEditorCaret(editor.current, 0)
        completionCaret.current = null
      })
      return
    }
    const before = draft.slice(0, query.start)
    if (item.kind === 'skill') {
      const index = before.split(skillMarker).length - 1
      const skills = [...selectedSkills.slice(0, index), command, ...selectedSkills.slice(index)]
      if (composerStore) {
        replaceQuery(`${skillMarker} `, skills)
        return
      }
      onSkills(skills)
    }
    replaceQuery(item.kind === 'skill' ? `${skillMarker} ` : `/${command.name} `)
  }

  function replaceQuery(insertion: string, skills?: PiSlashCommand[]) {
    if (!query) return
    const caret = query.start + insertion.length
    const text = draft.slice(0, query.start) + insertion + draft.slice(draftCaret)
    if (composerStore && skills) composerStore.patch({ draft: text, selectedSkills: skills })
    else onDraft(text)
    completionCaret.current = caret
    setDraftCaret(caret)
    setSuggestionsOpen(false)
    requestAnimationFrame(() => {
      if (editor.current) setEditorCaret(editor.current, caret)
      completionCaret.current = null
    })
    editor.current?.focus()
  }

  function completeFile(file: ProjectFile, drill = false) {
    if (query?.kind !== 'file') return
    const path = file.path + (file.kind === 'directory' ? '/' : '')
    const quoted = query.quoted || /\s/u.test(path)
    const insertion = quoted ? `@"${path}${drill ? '' : '"'}` : `@${path}`
    replaceFileQuery(insertion + (drill ? '' : ' '), drill)
  }

  function replaceFileQuery(insertion: string, open = true) {
    if (query?.kind !== 'file') return
    const caret = query.start + insertion.length
    onDraft(draft.slice(0, query.start) + insertion + draft.slice(draftCaret))
    completionCaret.current = caret
    setDraftCaret(caret)
    setSuggestionsOpen(open)
    editor.current?.focus()
    requestAnimationFrame(() => {
      if (editor.current) setEditorCaret(editor.current, caret)
      completionCaret.current = null
    })
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (fileCompletion) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSuggestionsOpen(false)
        return
      }
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
        event.preventDefault()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (fileMatches.length)
            setSuggestionIndex(
              (index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + fileMatches.length) % fileMatches.length,
            )
        } else if (fileMatches[activeIndex]) {
          const file = fileMatches[activeIndex]
          completeFile(file, event.key === 'Tab' && file.kind === 'directory')
        }
        return
      }
    }
    if (commandCompletion && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (matchCount) setSuggestionIndex((index) => (index + direction + matchCount) % matchCount)
      return
    }
    if (
      commandCompletion &&
      (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing))
    ) {
      event.preventDefault()
      if (matches[activeIndex]) completeItem(matches[activeIndex])
      return
    }
    if (event.key === 'Escape') {
      if (commandCompletion) {
        event.preventDefault()
        setSuggestionsOpen(false)
      } else if (hint) {
        event.preventDefault()
        onDismissHint?.()
      }
      return
    }
    if (hint && event.key === 'Tab' && !event.shiftKey && !draft.trim()) {
      event.preventDefault()
      onAcceptHint?.()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.closest('form')?.requestSubmit()
    }
  }

  return {
    editor,
    matches,
    commandCompletion,
    fileCompletion,
    fileMatches,
    fileQuery,
    fileError,
    filesLoading: fileCompletion && !currentFiles,
    completeFile,
    replaceFileQuery,
    skillCompletion,
    suggestionIndex: activeIndex,
    completeItem,
    keyDown,
    setDraftCaret,
    updateCaret: () => {
      if (editor.current && completionCaret.current === null) setDraftCaret(editorCaret(editor.current))
    },
    setSuggestionsOpen,
  }
}
