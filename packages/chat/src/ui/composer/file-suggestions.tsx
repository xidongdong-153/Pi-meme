import type { ProjectFile } from '@pi-meme/contracts/desktop'
import { ChevronRight, File, Folder } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { useSuggestionPlacement } from './use-suggestion-placement'

export function FileSuggestions({
  matches,
  query,
  loading,
  error,
  suggestionIndex,
  onComplete,
  onDirectory,
}: {
  matches: ProjectFile[]
  query: string
  loading: boolean
  error?: string
  suggestionIndex: number
  onComplete: (file: ProjectFile, drill?: boolean) => void
  onDirectory: (value: string) => void
}) {
  const { ref, placement, maxHeight } = useSuggestionPlacement()
  const slash = query.lastIndexOf('/')
  const directory = slash < 0 ? '' : query.slice(0, slash + 1)
  const segments = directory.split('/').filter(Boolean)
  return (
    <div
      ref={ref}
      className={cn(
        'absolute left-0 right-0 rounded-xl border border-border bg-popover p-1.5 shadow-xl z-30',
        placement === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="flex flex-wrap items-center gap-1 px-2.5 py-1 text-xs text-muted-foreground">
        <span className="shrink-0">文件与文件夹</span>
        {directory && (
          <nav aria-label="文件目录" className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
            {['项目', ...segments].map((segment, index) => {
              const path = segments.slice(0, index).join('/') + (index ? '/' : '')
              return (
                <button
                  key={index}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onDirectory(/\s/u.test(path) ? `@"${path}` : `@${path}`)}
                  className="min-w-0 max-w-full break-all text-left hover:text-foreground"
                >
                  / {segment}
                </button>
              )
            })}
          </nav>
        )}
      </div>
      <div
        id="composer-suggestions"
        role="listbox"
        aria-label="项目文件选择"
        className="max-h-[min(16rem,50vh)] overflow-y-auto overscroll-contain"
        style={{ scrollbarWidth: 'thin', maxHeight: maxHeight ? Math.max(100, maxHeight - 40) : undefined }}
      >
        {matches.map((file, index) => {
          const folder = file.kind === 'directory'
          const name = file.path.slice(file.path.lastIndexOf('/') + 1)
          const parent = file.path.slice(0, file.path.lastIndexOf('/') + 1)
          return (
            <div key={file.path} className={cn('flex rounded-md', index === suggestionIndex && 'bg-secondary')}>
              <button
                id={`composer-option-${index}`}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={index === suggestionIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onComplete(file)}
                className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-left hover:bg-secondary/60"
                title={file.path}
              >
                {folder ? (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <File className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {name}
                  {folder ? '/' : ''}
                </span>
                {!directory && parent && <span className="truncate text-muted-foreground">{parent}</span>}
              </button>
              {folder && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`进入目录 ${file.path}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onComplete(file, true)}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary/60"
                >
                  {index === suggestionIndex && <span>进入目录 Tab</span>}
                  <ChevronRight className="size-3.5" />
                </button>
              )}
            </div>
          )
        })}
        {!matches.length && (
          <div role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
            {loading ? '正在查找文件…' : error || '没有匹配的文件'}
          </div>
        )}
      </div>
    </div>
  )
}
