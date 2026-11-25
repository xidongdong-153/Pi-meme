import { desktopComputer } from '@pi-meme/contracts/computer-use'
import { goalCommands } from '@pi-meme/contracts/goal'
import { mcpMention, type McpCatalog, type McpService } from '@pi-meme/contracts/mcp'
import { planCompletion } from './plan-input'
import * as React from 'react'
import type { ProjectFile } from '@pi-meme/contracts/desktop'
import type { KeyboardEvent } from 'react'
import type { AgentPluginOption, ComposerProps } from './composer'
import { editorCaret, setEditorCaret, setEditorSelection } from './rich-draft'
import { skillMarker } from '@pi-meme/contracts/skills'
import { completionQuery, computerMention } from './completion-query'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'

export type CompletionItem =
  | { kind: 'command' | 'skill'; command: PiSlashCommand }
  | { kind: 'plugin'; plugin: AgentPluginOption }
  | { kind: 'mcp'; service: McpService; action: 'mention' | 'settings' | 'unavailable' }

export function useCommandCompletion({
  mobile = false,
  composerStore,
  onPlanCommand,
  onGoalCommand,
  onCompact,
  onNameCommand,
  sessionStarted = true,
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
  mcp,
  onPluginPosition,
  commands,
  focusVersion,
  editing,
}: Pick<
  ComposerProps,
  | 'composerStore'
  | 'onPlanCommand'
  | 'onGoalCommand'
  | 'onCompact'
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
  | 'mcp'
  | 'commands'
  | 'focusVersion'
  | 'onClearQueue'
> & {
  hasQueue: boolean
  onPluginPosition?: (id: string, offset: number) => void
  onNameCommand?: () => void
  /** 为 false 时不列出压缩和命名。新会话还没有对话。 */
  sessionStarted?: boolean
  editing?: boolean
  mobile?: boolean
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
    if (editor.current) {
      const selection = composerStore?.getSnapshot().selection
      if (selection) setEditorSelection(editor.current, selection)
      else setEditorCaret(editor.current, draftValue.current.length)
    }
  }, [focusVersion])

  const query = completionQuery(draft, draftCaret)
  const projectFiles = Boolean(projectPath && loadProjectFiles)
  const computerMatch = Boolean(
    desktopComputer() &&
    query?.kind === 'file' &&
    !query.quoted &&
    ['电脑', 'computer', 'computer-use'].some((name) => name.startsWith(query.query.toLowerCase())),
  )
  const fileCompletion = !mobile && suggestionsOpen && query?.kind === 'file' && (projectFiles || computerMatch)
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
  const catalogOpen = !mobile && suggestionsOpen && query?.kind === 'command'
  const loadMcp = mcp?.load
  const mcpKey = mcp?.sessionKey
  const [mcpResult, setMcpResult] = React.useState<{
    key?: string
    load: typeof loadMcp
    catalog?: McpCatalog
    error?: string
  }>()
  React.useEffect(() => {
    if (!catalogOpen || !loadMcp || !mcpKey) return
    let active = true
    void loadMcp(mcpKey).then(
      (catalog) => {
        if (active) setMcpResult({ key: mcpKey, load: loadMcp, catalog })
      },
      (cause) => {
        if (active) setMcpResult({ key: mcpKey, load: loadMcp, error: String(cause) })
      },
    )
    return () => {
      active = false
    }
  }, [catalogOpen, loadMcp, mcpKey])
  const currentMcp = mcpResult?.key === mcpKey && mcpResult?.load === loadMcp ? mcpResult : undefined
  const selectionContext = React.useMemo(() => ({}), [mcpKey, loadMcp, mcp?.available, draft, draftCaret, catalogOpen])
  const currentSelection = React.useRef(selectionContext)
  currentSelection.current = selectionContext
  const [checking, setChecking] = React.useState<{ context: typeof selectionContext; name: string }>()
  const skillCompletion = query?.kind === 'skill'
  const commandCompletion = !mobile && suggestionsOpen && Boolean(query && query.kind !== 'file')
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
    const top = !editing
      ? commands.flatMap<CompletionItem>((command) => {
          if (command.source === 'skill') return []
          if (
            !sessionStarted &&
            command.source === 'builtin' &&
            (command.name === 'compact' || command.name === 'name')
          )
            return []
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
        Number('command' in right && right.command.source === 'builtin') -
        Number('command' in left && left.command.source === 'builtin'),
    )
    const plugins: CompletionItem[] = (agentPlugins?.options ?? [])
      .filter((plugin) =>
        [plugin.id, plugin.name, plugin.description].some((value) => value?.toLowerCase().includes(prefix)),
      )
      .map((plugin) => ({ kind: 'plugin', plugin }))
    const services: CompletionItem[] = (currentMcp?.catalog?.services ?? [])
      .filter((s) => [s.name, s.description, 'mcp'].some((value) => value?.toLowerCase().includes(prefix)))
      .map((service) => ({
        kind: 'mcp',
        service,
        action: !mcp?.available
          ? 'unavailable'
          : !service.enabled ||
              !service.visible ||
              service.error ||
              service.check?.state === 'needs-auth' ||
              service.check?.state === 'failed'
            ? 'settings'
            : 'mention',
      }))
    return [...top, ...skills, ...services, ...plugins]
  }, [
    commands,
    editing,
    query?.kind,
    query?.query,
    sessionStarted,
    suggestionsOpen,
    agentPlugins?.options,
    currentMcp,
    mcp?.available,
  ])
  const selectable = matches.flatMap((item, index) =>
    (item.kind === 'plugin' && agentPlugins?.disabledReason) || (item.kind === 'mcp' && item.action === 'unavailable')
      ? []
      : [index],
  )
  const matchCount = fileCompletion ? fileMatches.length + Number(computerMatch) : selectable.length
  const activeIndex = fileCompletion
    ? Math.min(suggestionIndex, Math.max(0, matchCount - 1))
    : (selectable[Math.min(suggestionIndex, Math.max(0, matchCount - 1))] ?? -1)

  React.useEffect(() => setSuggestionIndex(0), [query?.kind, query?.query, projectPath])
  React.useEffect(() => {
    document.getElementById(`composer-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, matchCount])

  function completeItem(item: CompletionItem) {
    if (!query) return
    if (item.kind === 'mcp') {
      if (!mcp?.available || item.action === 'unavailable') return
      const target = { name: item.service.name, revision: item.service.revision, sessionKey: mcp.sessionKey }
      const manage = () => {
        setSuggestionsOpen(false)
        mcp.openSettings(target)
      }
      if (item.action === 'settings') {
        manage()
        return
      }
      if (item.service.transport === 'http' && !item.service.check) {
        if (checking?.context === selectionContext) return
        setChecking({ context: selectionContext, name: item.service.name })
        const stillActive = () =>
          !!editor.current && currentSelection.current === selectionContext && document.activeElement === editor.current
        void mcp
          .check(target)
          .then(
            (check) => {
              if (!stillActive()) return
              if (check.state === 'connected') replaceQuery(`${mcpMention(item.service)} `)
              else manage()
            },
            () => {
              if (stillActive()) manage()
            },
          )
          .finally(() => setChecking((current) => (current?.context === selectionContext ? undefined : current)))
        return
      }
      replaceQuery(`${mcpMention(item.service)} `)
      return
    }
    if (item.kind === 'plugin') {
      if (!agentPlugins || agentPlugins.disabledReason) return
      const { id } = item.plugin
      if (!agentPlugins.mentions.some((plugin) => plugin.id === id)) onPluginPosition?.(id, query.start)
      replaceQuery('')
      void agentPlugins.select(id)
      return
    }
    const command = item.command
    if (item.kind === 'command' && command.source === 'builtin') {
      if (command.name === 'compact' && onCompact) {
        onCompact()
        setSuggestionsOpen(false)
        editor.current?.focus()
        return
      }
      if (command.name === 'name' && onNameCommand) {
        onNameCommand()
        setSuggestionsOpen(false)
        return
      }
    }
    if (
      item.kind === 'command' &&
      command.source === 'builtin' &&
      (goalCommands as readonly string[]).includes(command.name) &&
      onGoalCommand
    ) {
      onGoalCommand(`/goal ${(draft.slice(0, query.start) + draft.slice(draftCaret)).trimStart()}`)
      setSuggestionsOpen(false)
      editor.current?.focus()
      return
    }
    const plan = item.kind === 'command' ? planCompletion(command, draft, query.start, draftCaret) : undefined
    if (plan !== undefined && onPlanCommand) {
      onPlanCommand(plan)
      const caret = draft.slice(0, query.start).trimStart().length
      completionCaret.current = caret
      setDraftCaret(caret)
      setSuggestionsOpen(false)
      editor.current?.focus()
      requestAnimationFrame(() => {
        if (editor.current) setEditorCaret(editor.current, caret)
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
    if (item.kind === 'skill') replaceQuery(`${skillMarker} `)
    else {
      const prefix = `/${command.name} `
      const body = (before + draft.slice(draftCaret)).trimStart()
      changeDraft(prefix + body, prefix.length + before.trimStart().length)
    }
  }

  function replaceQuery(insertion: string, skills?: PiSlashCommand[]) {
    if (!query) return
    const caret = query.start + insertion.length
    const text = draft.slice(0, query.start) + insertion + draft.slice(draftCaret)
    changeDraft(text, caret, skills)
  }

  function changeDraft(text: string, caret: number, skills?: PiSlashCommand[]) {
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
    const quoted = !drill || query.quoted || /\s/u.test(path)
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
          if (matchCount)
            setSuggestionIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + matchCount) % matchCount)
        } else if (computerMatch && activeIndex === 0) {
          replaceFileQuery(`${computerMention} `, false)
        } else if (fileMatches[activeIndex - Number(computerMatch)]) {
          const file = fileMatches[activeIndex - Number(computerMatch)]
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
    if (!mobile && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.closest('form')?.requestSubmit()
    }
  }

  return {
    editor,
    matches,
    commandCompletion,
    mcpStatus:
      catalogOpen && loadMcp && mcpKey
        ? checking?.context === selectionContext
          ? `正在检查 ${checking.name}…`
          : (currentMcp?.error ?? (!currentMcp ? '正在读取 MCP 服务…' : undefined))
        : undefined,
    fileCompletion,
    fileMatches,
    fileQuery,
    fileError,
    computerMatch,
    projectFiles,
    completeComputer: () => replaceFileQuery(`${computerMention} `, false),
    filesLoading: projectFiles && fileCompletion && !currentFiles,
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
