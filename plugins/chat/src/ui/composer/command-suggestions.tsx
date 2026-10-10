import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { Box } from 'lucide-react'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { cn } from '@pi-meme/ui/lib/utils'

export function CommandSuggestions({
  matches,
  skillCompletion,
  suggestionIndex,
  onComplete: completeCommand,
}: {
  matches: PiSlashCommand[]
  skillCompletion: boolean
  suggestionIndex: number
  onComplete: (command: PiSlashCommand) => void
}) {
  if (!matches.length) return null
  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 max-h-[min(16rem,50vh)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1.5 shadow-xl z-30"
      id="composer-suggestions"
      role="listbox"
      style={{ scrollbarWidth: 'thin' }}
      aria-label={skillCompletion ? '技能选择' : '斜杠命令'}
    >
      {matches.map((command, index) => (
        <button
          key={`${command.source}-${command.name}-${command.sourceInfo.path}`}
          id={`composer-option-${index}`}
          type="button"
          tabIndex={-1}
          role="option"
          aria-selected={index === suggestionIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => completeCommand(command)}
          className={cn(
            'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs text-foreground transition-colors cursor-pointer select-none text-left',
            index === suggestionIndex ? 'bg-secondary text-foreground font-medium' : 'hover:bg-secondary/60',
          )}
        >
          <div className="flex flex-1 items-center gap-2 min-w-0">
            {skillCompletion && <Box className="size-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 truncate font-medium" title={command.name}>
              {skillCompletion ? command.name.replace(/^skill:/, '') : `/${command.name}`}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={command.description}>
              {command.description ?? command.source}
            </span>
          </div>
          <Badge variant="outline" className="text-[0.625rem] py-0 px-1.5 shrink-0 ml-2">
            {skillCompletion
              ? { user: '用户技能', project: '项目技能', temporary: '临时技能' }[command.sourceInfo.scope]
              : { builtin: '内置', extension: '扩展', prompt: '提示词', skill: '技能' }[command.source]}
          </Badge>
        </button>
      ))}
    </div>
  )
}
