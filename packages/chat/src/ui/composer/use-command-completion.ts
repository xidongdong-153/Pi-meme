import { planCompletion } from './plan-input'
import * as React from 'react'
import type { ProjectFile } from '@pi-meme/contracts/desktop'
import type { KeyboardEvent } from 'react'
import type { ComposerProps } from './composer'
import { editorCaret, setEditorCaret } from './rich-draft'
import { skillMarker } from '@pi-meme/contracts/skills'
import { completionQuery } from './completion-query'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

export function useCommandCompletion({
  onPlanCommand,
  projectPath,
  loadProjectFiles,
  draft,
  onDraft,
  onSkills,
  selectedSkills,
  commands,
  focusVersion,
}: Pick<
  ComposerProps,
  | 'onPlanCommand'
  | 'projectPath'
  | 'loadProjectFiles'
  | 'draft'
  | 'onDraft'
  | 'onSkills'
  | 'selectedSkills'
  | 'commands'
  | 'focusVersion'
  | 'onClearQueue'
> & {
  hasQueue: boolean
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
  const matches = React.useMemo(() => {
    if (!suggestionsOpen || !query || query.kind === 'file') return []
    const prefix = query.query.toLowerCase()
    if (query.kind === 'skill') {
      return commands.filter(
        (command) =>
          command.source === 'skill' &&
          (command.name.slice(6).toLowerCase().includes(prefix) || command.description?.toLowerCase().includes(prefix)),
      )
    }
    const canonicalPlan = commands.find((command) => command.source === 'builtin' && command.name === 'plan')
    let planSeen = false
    return commands.flatMap((command) => {
      const plan = command.source === 'builtin' && ['plan', '计划', '计划模式'].includes(command.name)
      if (plan && planSeen) return []
      if (plan) planSeen = true
      const preferred = plan ? (canonicalPlan ?? command) : command
      const candidate = plan && preferred.name !== 'plan' ? { ...preferred, name: 'plan' } : preferred
      return candidate.name.toLowerCase().startsWith(prefix) || (plan && '计划模式'.startsWith(prefix))
        ? [candidate]
        : []
    })
  }, [commands, query?.kind, query?.query, suggestionsOpen])
  const matchCount = fileCompletion ? fileMatches.length : matches.length
  const activeIndex = Math.min(suggestionIndex, Math.max(0, matchCount - 1))

  React.useEffect(() => setSuggestionIndex(0), [query?.kind, query?.query, projectPath])
  React.useEffect(() => {
    document.getElementById(`composer-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, matchCount])

  function completeCommand(command: PiSlashCommand) {
    if (!query) return
    const plan = planCompletion(command, draft, query.start, draftCaret)
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
    const after = draft.slice(draftCaret)
    const insertion = query.kind === 'skill' ? `${skillMarker} ` : `/${command.name} `
    const caret = before.length + insertion.length
    if (query.kind === 'skill') {
      const index = before.split(skillMarker).length - 1
      onSkills([...selectedSkills.slice(0, index), command, ...selectedSkills.slice(index)])
    }
    onDraft(`${before}${insertion}${after}`)
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
    if (matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setSuggestionIndex((index) => (index + direction + matches.length) % matches.length)
      return
    }
    if (
      matches.length &&
      (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing))
    ) {
      event.preventDefault()
      completeCommand(matches[activeIndex])
      return
    }
    if (event.key === 'Escape') {
      if (matches.length) {
        event.preventDefault()
        setSuggestionsOpen(false)
      }
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
    fileCompletion,
    fileMatches,
    fileQuery,
    fileError,
    filesLoading: fileCompletion && !currentFiles,
    completeFile,
    replaceFileQuery,
    skillCompletion,
    suggestionIndex: activeIndex,
    completeCommand,
    keyDown,
    setDraftCaret,
    updateCaret: () => {
      if (editor.current && completionCaret.current === null) setDraftCaret(editorCaret(editor.current))
    },
    setSuggestionsOpen,
  }
}
