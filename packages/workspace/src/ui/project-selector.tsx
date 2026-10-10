import { useRef, useState } from 'react'
import { Check, ChevronDown, Folder, Plus, Search, X } from 'lucide-react'
import type { DesktopProject, SelectWorkspace, WorkspaceKind } from '@pi-meme/contracts/sessions'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'

function projectPathLabel(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : cwd
}

export function ProjectSelector({
  cwd,
  kind,
  open,
  onOpenChange,
  disabledReason,
  loadProjects,
  onSelect,
  onAdd,
  onError,
  notice,
  returnFocus,
}: {
  cwd: string
  kind?: WorkspaceKind
  open: boolean
  onOpenChange: (open: boolean) => void
  disabledReason?: string
  loadProjects: () => Promise<DesktopProject[]>
  onSelect: (input: SelectWorkspace) => Promise<boolean>
  onAdd: () => Promise<boolean>
  onError: (message: string) => void
  notice?: string
  returnFocus?: HTMLElement | null
}) {
  const [projects, setProjects] = useState<DesktopProject[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const request = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const switching = useRef(false)
  const focusEditor = useRef(false)
  const blocked = Boolean(disabledReason) || choosing
  const standalone = kind === 'standalone'
  const name = standalone ? '不在项目中工作' : cwd.split(/[\\/]/).filter(Boolean).at(-1) || '选择项目'
  const search = query.trim().toLocaleLowerCase()
  const filtered = projects
    .filter((project) => [project.name, project.cwd].some((value) => value.toLocaleLowerCase().includes(search)))
    .sort((a, b) => (!search ? Number(b.cwd === cwd) - Number(a.cwd === cwd) : 0))

  function changeOpen(next: boolean) {
    if (next && disabledReason) return
    if (!next) request.current += 1
    onOpenChange(next)
  }

  async function readProjects() {
    const id = ++request.current
    setQuery('')
    setActiveIndex(0)
    setLoading(true)
    setLoadError('')
    setProjects([])
    try {
      const result = await loadProjects()
      if (id === request.current) setProjects(result)
    } catch (cause) {
      if (id === request.current) setLoadError(`无法读取项目：${String(cause)}`)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  async function choose(index: number) {
    if (disabledReason || switching.current) return
    switching.current = true
    setChoosing(true)
    try {
      const changed =
        index === filtered.length
          ? await onAdd()
          : await onSelect(
              index === filtered.length + 1 ? { kind: 'standalone' } : { kind: 'project', cwd: filtered[index].cwd },
            )
      if (changed) {
        focusEditor.current = true
        await changeOpen(false)
      }
    } catch (cause) {
      onError(String(cause))
    } finally {
      switching.current = false
      setChoosing(false)
    }
  }

  return (
    <div className="mb-2 border-b border-border/60 pb-2">
      <Popover open={open} onOpenChange={(next) => void changeOpen(next)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="选择当前项目"
            disabled={blocked}
            title={disabledReason || (standalone ? '文件保存在此会话的独立目录' : cwd)}
            className="flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            <Folder className="size-4 shrink-0" />
            <span className="truncate">{name}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          aria-label="项目选择"
          side="top"
          align="start"
          className="flex flex-col w-64 max-w-[calc(100vw-24px)] p-1.5 rounded-2xl select-none"
          style={{ maxHeight: 'min(360px, var(--radix-popover-content-available-height))' }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            searchRef.current?.focus()
            void readProjects()
          }}
          onCloseAutoFocus={(event) => {
            if (!focusEditor.current) {
              if (returnFocus?.isConnected) {
                event.preventDefault()
                returnFocus.focus()
              }
              return
            }
            event.preventDefault()
            focusEditor.current = false
            document.querySelector<HTMLElement>('[contenteditable=true][aria-label="消息"]')?.focus()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const count = filtered.length + 2
              const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
              setActiveIndex(next)
              contentRef.current
                ?.querySelector<HTMLElement>(`[data-project-index="${next}"]`)
                ?.scrollIntoView({ block: 'nearest' })
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (!loading && (!loadError || activeIndex >= filtered.length))
                void choose(Math.min(activeIndex, filtered.length + 1))
            }
          }}
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-1.5 pb-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
            <Input
              ref={searchRef}
              aria-label="搜索项目"
              placeholder="搜索项目"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="min-h-0 max-h-60 overflow-y-auto">
            <div role="listbox" aria-label="项目列表" className="space-y-0.5 py-1">
              {loading || loadError || !filtered.length ? (
                <p className="px-2 py-3 text-xs text-muted-foreground" role={loadError ? 'alert' : 'status'}>
                  {loading ? '正在读取项目' : loadError || '未找到项目'}
                </p>
              ) : (
                filtered.map((project, index) => (
                  <button
                    key={project.cwd}
                    type="button"
                    role="option"
                    aria-selected={!standalone && cwd === project.cwd}
                    data-project-index={index}
                    title={project.cwd}
                    disabled={blocked}
                    onClick={() => void choose(index)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/60 disabled:opacity-50 cursor-pointer',
                      activeIndex === index && 'bg-secondary/70 text-foreground font-medium',
                    )}
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground/80" />
                    <span className="min-w-0 flex-1 leading-snug">
                      <span className="block truncate font-medium">{project.name}</span>
                      <span className="block truncate text-[0.625rem] text-muted-foreground/70">
                        {project.unavailable ? '目录不可用 · ' : ''}
                        {projectPathLabel(project.cwd)}
                      </span>
                    </span>
                    {!standalone && cwd === project.cwd && <Check className="size-3.5 shrink-0 text-foreground ml-1" />}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="shrink-0 space-y-0.5 border-t border-border/40 pt-1">
            <button
              type="button"
              data-project-index={filtered.length}
              disabled={blocked}
              onClick={() => void choose(filtered.length)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-secondary/60 disabled:opacity-50 cursor-pointer transition-colors',
                activeIndex === filtered.length && 'bg-secondary/70 text-foreground font-medium',
              )}
            >
              <Plus className="size-3.5 shrink-0" />
              新建项目
            </button>
            <button
              type="button"
              data-project-index={filtered.length + 1}
              disabled={blocked}
              onClick={() => void choose(filtered.length + 1)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-secondary/60 disabled:opacity-50 cursor-pointer transition-colors',
                activeIndex === filtered.length + 1 && 'bg-secondary/70 text-foreground font-medium',
              )}
            >
              <X className="size-3.5 shrink-0" />
              不在项目中工作{standalone && <Check className="ml-auto size-3.5 shrink-0" />}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {notice && (
        <p role="status" className="mt-1 px-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  )
}
