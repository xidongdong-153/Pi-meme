import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { AlertTriangle, ArrowUpRight, Check, Clock, Copy, Globe, Lock, Monitor, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type {
  BrowserHistory,
  BrowserPlatform,
  BrowserSearchQuery,
  BrowserSettings,
  BrowserSuggestion,
  BrowserTab,
} from '@pi-meme/contracts/browser'
import { isLikelyUrlInput, isLocalBrowserUrl, searchEngineLabel } from '../shared/navigation'

export function BrowserFavicon({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return src && !failed ? (
    <img
      src={src}
      alt=""
      className={cn('size-4 shrink-0 rounded-sm object-contain', className)}
      onError={() => setFailed(true)}
    />
  ) : (
    <Globe className={cn('size-4 shrink-0', className)} />
  )
}

export type OmniboxToolItem = {
  id: string
  title: string
  icon: ReactNode
}

type Candidate =
  | { key: string; kind: 'primary'; fill: string; query: string; isUrl: boolean }
  | { key: string; kind: 'tool'; fill: string; tool: OmniboxToolItem }
  | { key: string; kind: 'tab'; fill: string; tab: BrowserTab }
  | { key: string; kind: 'query'; fill: string; entry: BrowserSearchQuery }
  | { key: string; kind: 'history'; fill: string; entry: BrowserHistory }
  | { key: string; kind: 'suggestion'; fill: string; suggestion: BrowserSuggestion }

function shortDisplayUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '')
    return path ? `${parsed.host}${path}` : parsed.host
  } catch {
    return raw
  }
}

function splitUrlParts(raw: string): { protocol: string; host: string; rest: string } | null {
  try {
    const parsed = new URL(raw)
    return {
      protocol: `${parsed.protocol}//`,
      host: parsed.host,
      rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    }
  } catch {
    return null
  }
}

function renderMatchedText(text: string, query: string, mode: 'match' | 'completion') {
  const trimmed = query.trim()
  if (!trimmed) return <span>{text}</span>
  const lowerText = text.toLocaleLowerCase()
  const lowerQuery = trimmed.toLocaleLowerCase()
  if (mode === 'completion') {
    if (lowerText.startsWith(lowerQuery) && text.length > trimmed.length) {
      return (
        <span>
          <span className="font-normal text-foreground/85">{text.slice(0, trimmed.length)}</span>
          <span className="font-semibold text-foreground">{text.slice(trimmed.length)}</span>
        </span>
      )
    }
    return <span className="font-medium text-foreground">{text}</span>
  }
  const index = lowerText.indexOf(lowerQuery)
  if (index === -1) return <span>{text}</span>
  return (
    <span>
      {text.slice(0, index)}
      <span className="font-semibold text-foreground">{text.slice(index, index + trimmed.length)}</span>
      {text.slice(index + trimmed.length)}
    </span>
  )
}

export function BrowserOmnibox({
  variant,
  platform,
  value,
  onChange,
  currentUrl = 'about:blank',
  hoverUrl = '',
  fullUrl = false,
  zoom = 1,
  onResetZoom,
  searchEngine = 'bing',
  searchSuggestionsEnabled = true,
  history = [],
  searchQueries = [],
  openTabs = [],
  currentTabId,
  tools = [],
  placeholder = '搜索或输入网址',
  autoFocus = false,
  inputRef,
  onSubmitUrl,
  onSwitchTab,
  onSelectTool,
  onRemoveSearchQuery,
  onEscapeToPage,
  onDropdownOpenChange,
  className,
}: {
  variant: 'toolbar' | 'hero'
  platform?: BrowserPlatform
  value: string
  onChange: (value: string) => void
  currentUrl?: string
  hoverUrl?: string
  fullUrl?: boolean
  zoom?: number
  onResetZoom?: () => void
  searchEngine?: BrowserSettings['search']
  searchSuggestionsEnabled?: boolean
  history?: BrowserHistory[]
  searchQueries?: BrowserSearchQuery[]
  openTabs?: BrowserTab[]
  currentTabId?: string
  tools?: OmniboxToolItem[]
  placeholder?: string
  autoFocus?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  onSubmitUrl: (input: string) => void
  onSwitchTab?: (tabId: string) => void
  onSelectTool?: (toolId: string) => void
  onRemoveSearchQuery?: (query: string) => void
  onEscapeToPage?: () => void
  onDropdownOpenChange?: (open: boolean) => void
  className?: string
}) {
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const resolvedInputRef = inputRef ?? localInputRef
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const [focused, setFocused] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [suggestionState, setSuggestionState] = useState<{ query: string; items: BrowserSuggestion[] }>({
    query: '',
    items: [],
  })
  const [copied, setCopied] = useState(false)
  const suggestSequence = useRef(0)
  const trimmed = value.trim()
  const isBlank = currentUrl === 'about:blank'
  const engineLabel = searchEngineLabel(searchEngine)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(setCopied, 1500, false)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    const seq = ++suggestSequence.current
    if (!platform || !dropdownOpen || !trimmed || isLikelyUrlInput(trimmed) || !searchSuggestionsEnabled) {
      setSuggestionState({ query: '', items: [] })
      return
    }
    const timer = window.setTimeout(() => {
      void platform
        .suggest(trimmed)
        .then((items) => {
          if (suggestSequence.current === seq) setSuggestionState({ query: trimmed, items })
        })
        .catch(() => {
          if (suggestSequence.current === seq) setSuggestionState({ query: trimmed, items: [] })
        })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [platform, dropdownOpen, trimmed, searchSuggestionsEnabled])

  const candidates = useMemo<Candidate[]>(() => {
    if (!dropdownOpen) return []
    const items: Candidate[] = []
    if (!trimmed) {
      if (variant === 'hero') return []
      for (const entry of searchQueries.slice(0, 2)) {
        items.push({ key: `query:${entry.query}`, kind: 'query', fill: entry.query, entry })
      }
      for (const entry of history.slice(0, 5 - items.length)) {
        items.push({ key: `history:${entry.id}`, kind: 'history', fill: entry.url, entry })
      }
      return items
    }

    const lower = trimmed.toLocaleLowerCase()
    const isUrl = isLikelyUrlInput(trimmed)
    const primaryItem: Candidate = { key: `primary:${trimmed}`, kind: 'primary', fill: trimmed, query: trimmed, isUrl }

    if (variant === 'hero' && !isUrl) {
      const matchedTools = tools.filter((tool) => tool.title.toLocaleLowerCase().includes(lower))
      const exactTool = matchedTools.find((tool) => tool.title.toLocaleLowerCase() === lower)
      if (exactTool) {
        items.push({ key: `tool:${exactTool.id}`, kind: 'tool', fill: exactTool.title, tool: exactTool })
        items.push(primaryItem)
        for (const tool of matchedTools.filter((item) => item.id !== exactTool.id).slice(0, 2)) {
          items.push({ key: `tool:${tool.id}`, kind: 'tool', fill: tool.title, tool })
        }
      } else {
        items.push(primaryItem)
        for (const tool of matchedTools.slice(0, 3)) {
          items.push({ key: `tool:${tool.id}`, kind: 'tool', fill: tool.title, tool })
        }
      }
    } else {
      items.push(primaryItem)
    }

    if (onSwitchTab) {
      const matchedTabs = openTabs
        .filter(
          (tab) =>
            tab.id !== currentTabId &&
            tab.url !== 'about:blank' &&
            (tab.title.toLocaleLowerCase().includes(lower) || tab.url.toLocaleLowerCase().includes(lower)),
        )
        .slice(0, 2)
      for (const tab of matchedTabs) {
        items.push({ key: `tab:${tab.id}`, kind: 'tab', fill: tab.url, tab })
      }
    }

    const shownQueries = new Set<string>(isUrl ? [] : [lower])
    for (const entry of searchQueries) {
      const qLower = entry.query.toLocaleLowerCase()
      if (shownQueries.has(qLower) || !qLower.includes(lower)) continue
      shownQueries.add(qLower)
      items.push({ key: `query:${entry.query}`, kind: 'query', fill: entry.query, entry })
      if (items.filter((item) => item.kind === 'query').length >= 2) break
    }

    const shownTabUrls = new Set(
      items.filter((item): item is Extract<Candidate, { kind: 'tab' }> => item.kind === 'tab').map((i) => i.tab.url),
    )
    const now = Date.now()
    const matchedHistory = history
      .filter(
        (entry) =>
          !shownTabUrls.has(entry.url) &&
          (entry.title.toLocaleLowerCase().includes(lower) || entry.url.toLocaleLowerCase().includes(lower)),
      )
      .sort((a, b) => {
        const ageA = Math.max(1, (now - Date.parse(a.visitedAt)) / 3_600_000)
        const ageB = Math.max(1, (now - Date.parse(b.visitedAt)) / 3_600_000)
        const scoreA = (a.visitCount ?? 1) * 10 + 100 / ageA
        const scoreB = (b.visitCount ?? 1) * 10 + 100 / ageB
        return scoreB - scoreA
      })
      .slice(0, 3)
    for (const entry of matchedHistory) {
      items.push({ key: `history:${entry.id}`, kind: 'history', fill: entry.url, entry })
    }

    const suggestionQueryLower = suggestionState.query.toLocaleLowerCase()
    const activeSuggestions =
      suggestionQueryLower === lower
        ? suggestionState.items
        : suggestionQueryLower && lower.startsWith(suggestionQueryLower)
          ? suggestionState.items.filter((item) => item.text.toLocaleLowerCase().includes(lower))
          : []

    for (const suggestion of activeSuggestions) {
      if (items.length >= 8) break
      const sLower = suggestion.text.toLocaleLowerCase()
      if (shownQueries.has(sLower)) continue
      shownQueries.add(sLower)
      items.push({ key: `suggestion:${suggestion.text}`, kind: 'suggestion', fill: suggestion.text, suggestion })
    }

    return items.slice(0, 8)
  }, [
    dropdownOpen,
    trimmed,
    variant,
    searchQueries,
    history,
    tools,
    openTabs,
    currentTabId,
    onSwitchTab,
    suggestionState,
  ])

  const showPopover = dropdownOpen && candidates.length > 0

  useEffect(() => {
    onDropdownOpenChange?.(showPopover)
  }, [showPopover, onDropdownOpenChange])

  useEffect(() => {
    setActiveIndex(0)
  }, [trimmed, showPopover])

  const executeCandidate = (candidate: Candidate) => {
    setDropdownOpen(false)
    if (candidate.kind === 'tool') {
      onSelectTool?.(candidate.tool.id)
      return
    }
    if (candidate.kind === 'tab') {
      onSwitchTab?.(candidate.tab.id)
      return
    }
    if (candidate.kind === 'query') {
      onChange(candidate.entry.query)
      onSubmitUrl(candidate.entry.query)
      resolvedInputRef.current?.blur()
      return
    }
    if (candidate.kind === 'history') {
      onChange(candidate.entry.url)
      onSubmitUrl(candidate.entry.url)
      resolvedInputRef.current?.blur()
      return
    }
    if (candidate.kind === 'suggestion') {
      onChange(candidate.suggestion.text)
      onSubmitUrl(candidate.suggestion.text)
      resolvedInputRef.current?.blur()
      return
    }
    onSubmitUrl(candidate.query)
    resolvedInputRef.current?.blur()
  }

  const leftIcon = (() => {
    if (variant === 'hero' || focused || isBlank) {
      return isLikelyUrlInput(trimmed) ? (
        <Globe className={cn(variant === 'hero' ? 'size-4' : 'size-3.5', 'shrink-0 text-muted-foreground')} />
      ) : (
        <Search className={cn(variant === 'hero' ? 'size-4' : 'size-3.5', 'shrink-0 text-muted-foreground')} />
      )
    }
    if (isLocalBrowserUrl(currentUrl)) {
      return (
        <TooltipHint content="本机服务">
          <span className="inline-flex shrink-0 text-muted-foreground">
            <Monitor className="size-3.5" />
          </span>
        </TooltipHint>
      )
    }
    if (currentUrl.startsWith('https://')) {
      return (
        <TooltipHint content="安全连接（HTTPS）">
          <span className="inline-flex shrink-0 text-muted-foreground">
            <Lock className="size-3.5" />
          </span>
        </TooltipHint>
      )
    }
    return (
      <TooltipHint content="非加密连接（HTTP）">
        <span className="inline-flex shrink-0 text-amber-500/85">
          <AlertTriangle className="size-3.5" />
        </span>
      </TooltipHint>
    )
  })()

  const showOverlayText = variant === 'toolbar' && !focused && (!isBlank || Boolean(hoverUrl))
  const parts = splitUrlParts(currentUrl)
  const zoomPercent = Math.round(zoom * 100)

  return (
    <div
      ref={containerRef}
      className={cn('relative min-w-0 flex-1', className)}
      onBlur={(event) => {
        if (containerRef.current?.contains(event.relatedTarget as Node | null)) return
        setFocused(false)
        setDropdownOpen(false)
      }}
    >
      <form
        className={cn(
          'group/omnibox relative flex items-center gap-2 border transition-colors',
          variant === 'hero'
            ? showPopover
              ? 'h-11 rounded-t-[22px] rounded-b-none border-border/70 border-b-0 bg-popover px-4'
              : 'h-11 rounded-full border-border/60 bg-secondary/55 px-4 shadow-xs focus-within:border-foreground/20 focus-within:bg-popover/95'
            : showPopover
              ? 'h-8 rounded-t-2xl rounded-b-none border-border/70 border-b-0 bg-popover px-2.5'
              : 'h-8 rounded-full border-transparent bg-secondary/80 px-2.5 focus-within:border-foreground/20 focus-within:bg-popover/95',
        )}
        onSubmit={(event) => {
          event.preventDefault()
          if (showPopover && candidates[activeIndex]) {
            executeCandidate(candidates[activeIndex])
            return
          }
          if (trimmed) {
            setDropdownOpen(false)
            onSubmitUrl(trimmed)
            resolvedInputRef.current?.blur()
          }
        }}
      >
        {leftIcon}
        <div className="relative flex min-w-0 flex-1 items-center">
          <input
            ref={resolvedInputRef}
            autoFocus={autoFocus}
            role="combobox"
            aria-expanded={showPopover}
            aria-controls={showPopover ? listboxId : undefined}
            aria-activedescendant={showPopover && candidates[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-label={placeholder}
            placeholder={showOverlayText ? '' : placeholder}
            value={value}
            onFocus={(event) => {
              setFocused(true)
              if (variant === 'toolbar') {
                const nextValue = isBlank ? '' : currentUrl
                if (value !== nextValue) onChange(nextValue)
                setDropdownOpen(true)
              } else {
                setDropdownOpen(Boolean(trimmed))
              }
              event.currentTarget.select()
            }}
            onChange={(event) => {
              const next = event.target.value
              onChange(next)
              setDropdownOpen(variant === 'toolbar' ? true : Boolean(next.trim()))
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                if (event.key === 'Enter') event.preventDefault()
                return
              }
              if (event.key === 'ArrowDown' && candidates.length) {
                event.preventDefault()
                if (!dropdownOpen) setDropdownOpen(true)
                else setActiveIndex((prev) => (prev + 1) % candidates.length)
                return
              }
              if (event.key === 'ArrowUp' && candidates.length) {
                event.preventDefault()
                if (!dropdownOpen) setDropdownOpen(true)
                else setActiveIndex((prev) => (prev - 1 + candidates.length) % candidates.length)
                return
              }
              if (event.key === 'Tab' && showPopover && candidates[activeIndex]) {
                const target = candidates[activeIndex]
                if (target.kind === 'query' || target.kind === 'suggestion' || target.kind === 'history') {
                  event.preventDefault()
                  onChange(target.fill)
                }
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (showPopover) {
                  setDropdownOpen(false)
                  return
                }
                if (variant === 'toolbar') {
                  onChange(isBlank ? '' : currentUrl)
                  event.currentTarget.blur()
                  onEscapeToPage?.()
                } else {
                  onChange('')
                }
              }
            }}
            className={cn(
              'w-full bg-transparent outline-none',
              variant === 'hero' ? 'text-sm' : 'text-xs',
              showOverlayText ? 'text-transparent caret-transparent selection:bg-transparent' : 'text-foreground',
            )}
          />
          {showOverlayText ? (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center truncate text-xs">
              {hoverUrl ? (
                <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                  <ArrowUpRight className="size-3 shrink-0" />
                  <span className="truncate">{hoverUrl}</span>
                </span>
              ) : fullUrl && parts ? (
                <span className="truncate">
                  <span className="text-muted-foreground">{parts.protocol}</span>
                  <span className="font-medium text-foreground">{parts.host}</span>
                  <span className="text-muted-foreground">{parts.rest === '/' ? '' : parts.rest}</span>
                </span>
              ) : (
                <span className="truncate font-medium text-foreground">{parts?.host ?? currentUrl}</span>
              )}
            </div>
          ) : null}
        </div>
        {variant === 'toolbar' && !focused && !isBlank && !hoverUrl ? (
          <TooltipHint content={copied ? '已复制网址' : '复制网址'}>
            <button
              type="button"
              aria-label="复制网址"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void navigator.clipboard.writeText(currentUrl).then(() => setCopied(true))
              }}
              className="hidden size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground group-hover/omnibox:inline-flex"
            >
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </button>
          </TooltipHint>
        ) : null}
        {variant === 'toolbar' && !focused && zoomPercent !== 100 && onResetZoom ? (
          <TooltipHint content="点击重置为 100%">
            <button
              type="button"
              aria-label={`当前缩放 ${zoomPercent}%，点击重置`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onResetZoom}
              className="shrink-0 rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground hover:bg-background hover:text-foreground"
            >
              {zoomPercent}%
            </button>
          </TooltipHint>
        ) : null}
        {focused && trimmed ? (
          <button
            type="button"
            aria-label="清空输入"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange('')
              resolvedInputRef.current?.focus()
            }}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </form>

      {showPopover ? (
        <div
          id={listboxId}
          role="listbox"
          data-browser-popover="open"
          className={cn(
            'absolute left-0 right-0 z-50 mt-0 overflow-hidden border border-border/70 border-t border-t-border/40 bg-popover text-popover-foreground shadow-2xl',
            variant === 'hero'
              ? 'rounded-b-[22px] rounded-t-none pb-2 pt-1'
              : 'rounded-b-2xl rounded-t-none pb-1.5 pt-1',
          )}
        >
          {candidates.map((candidate, index) => {
            const active = index === activeIndex
            return (
              <div
                key={candidate.key}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  executeCandidate(candidate)
                }}
                className={cn(
                  'group/item relative mr-2 flex cursor-pointer items-center gap-2.5 rounded-r-full transition-colors',
                  variant === 'hero' ? 'py-2.5 pl-4 pr-3.5 text-[13px]' : 'py-2 pl-3 pr-3 text-xs',
                  active ? 'bg-foreground/[0.08] text-foreground' : 'text-foreground/90 hover:bg-foreground/[0.05]',
                )}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-1 left-0 top-1 w-[3px] rounded-r-full bg-primary"
                  />
                ) : null}
                {candidate.kind === 'primary' ? (
                  <>
                    {candidate.isUrl ? (
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {candidate.isUrl ? (
                        <>
                          <span className="font-medium text-foreground">{candidate.query}</span>
                          <span className="text-muted-foreground"> - 访问网址</span>
                        </>
                      ) : (
                        <>
                          <span className="font-medium text-foreground">{candidate.query}</span>
                          <span className="text-muted-foreground"> - {engineLabel} 搜索</span>
                        </>
                      )}
                    </span>
                  </>
                ) : candidate.kind === 'tool' ? (
                  <>
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">
                      {candidate.tool.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {renderMatchedText(candidate.tool.title, trimmed, 'match')}
                    </span>
                    <span className="shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] text-muted-foreground">
                      工具
                    </span>
                  </>
                ) : candidate.kind === 'tab' ? (
                  <>
                    <BrowserFavicon src={candidate.tab.favicon} className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {renderMatchedText(candidate.tab.title || candidate.tab.url, trimmed, 'match')}
                      <span className="text-muted-foreground"> - </span>
                      <span className="text-primary/80">{shortDisplayUrl(candidate.tab.url)}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] text-muted-foreground">
                      切换到标签页
                    </span>
                  </>
                ) : candidate.kind === 'query' ? (
                  <>
                    <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {renderMatchedText(candidate.entry.query, trimmed, 'match')}
                    </span>
                    {onRemoveSearchQuery ? (
                      <button
                        type="button"
                        aria-label={`移除搜索记录：${candidate.entry.query}`}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onRemoveSearchQuery(candidate.entry.query)
                        }}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover/item:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </>
                ) : candidate.kind === 'history' ? (
                  <>
                    <BrowserFavicon src={candidate.entry.favicon} className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {renderMatchedText(
                        candidate.entry.title || shortDisplayUrl(candidate.entry.url),
                        trimmed,
                        'match',
                      )}
                      <span className="text-muted-foreground"> - </span>
                      <span className="text-primary/80">{shortDisplayUrl(candidate.entry.url)}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {renderMatchedText(candidate.suggestion.text, trimmed, 'completion')}
                      {candidate.suggestion.description ? (
                        <span className="text-muted-foreground"> - {candidate.suggestion.description}</span>
                      ) : null}
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
