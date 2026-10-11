import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { Box } from 'lucide-react'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
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
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2 overflow-y-auto overscroll-contain border border-border bg-popover p-1.5 shadow-xl z-30',
        skillCompletion ? 'max-h-[min(22rem,50vh)] rounded-2xl font-mono' : 'max-h-[min(16rem,50vh)] rounded-xl',
      )}
      id="composer-suggestions"
      role="listbox"
      style={{ scrollbarWidth: 'thin' }}
      aria-label={skillCompletion ? '技能选择' : '斜杠命令'}
    >
      {matches.map((command, index) => {
        const key = `${command.source}-${command.name}-${command.sourceInfo.path}`
        const option = (
          <button
            key={key}
            id={`composer-option-${index}`}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={index === suggestionIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => completeCommand(command)}
            className={cn(
              'flex w-full items-center justify-between text-foreground transition-colors cursor-pointer select-none text-left',
              skillCompletion ? 'gap-3 rounded-xl px-3 py-2 text-sm' : 'rounded-md px-2.5 py-1.5 text-xs',
              index === suggestionIndex ? 'bg-secondary text-foreground font-medium' : 'hover:bg-secondary/60',
            )}
          >
            <div className="flex flex-1 items-center gap-2 min-w-0">
              {skillCompletion && <Box className="size-4 shrink-0 text-muted-foreground" />}
              <span
                className={cn('min-w-0 truncate font-medium', skillCompletion && 'max-w-[45%] shrink-0')}
                title={skillCompletion ? undefined : command.name}
              >
                {skillCompletion ? (command.displayName ?? command.name.replace(/^skill:/, '')) : `/${command.name}`}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={skillCompletion ? undefined : command.description}
              >
                {(skillCompletion ? command.shortDescription : undefined) ?? command.description ?? command.source}
              </span>
            </div>
            {skillCompletion ? (
              <span className="shrink-0 text-muted-foreground">
                {command.builtin
                  ? '内置'
                  : { user: '本地文件', project: '项目', temporary: '临时' }[command.sourceInfo.scope]}
              </span>
            ) : (
              <Badge variant="outline" className="text-[0.625rem] py-0 px-1.5 shrink-0 ml-2">
                {{ builtin: '内置', extension: '扩展', prompt: '提示词', skill: '技能' }[command.source]}
              </Badge>
            )}
          </button>
        )
        return skillCompletion ? (
          <Tooltip key={key} delayDuration={300}>
            <TooltipTrigger asChild>{option}</TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[min(32rem,calc(100vw-2rem))] break-all rounded-xl px-4 py-2 text-center font-mono text-sm"
            >
              {command.sourceInfo.path}
            </TooltipContent>
          </Tooltip>
        ) : (
          option
        )
      })}
    </div>
  )
}
