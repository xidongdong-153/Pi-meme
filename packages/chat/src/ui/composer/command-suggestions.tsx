import { Box } from 'lucide-react'
import { builtinCommandIcons } from '@pi-meme/assets/builtin'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ComposerAgentPlugins } from './composer'
import type { CompletionItem } from './use-command-completion'
import { useSuggestionPlacement } from './use-suggestion-placement'

const builtinCommandLabels: Record<string, string> = {
  plan: '计划',
  goal: '目标',
  compact: '压缩',
  name: '命名',
}

export function CommandSuggestions({
  matches,
  skillCompletion,
  agentPlugins,
  suggestionIndex,
  onComplete,
}: {
  matches: CompletionItem[]
  skillCompletion: boolean
  agentPlugins?: ComposerAgentPlugins
  suggestionIndex: number
  onComplete: (item: CompletionItem) => void
}) {
  const { ref, placement, maxHeight } = useSuggestionPlacement()

  function option(item: CompletionItem, index: number) {
    const plugin = item.kind === 'plugin' ? item.plugin : undefined
    const command = item.kind === 'plugin' ? undefined : item.command
    const resource = item.kind !== 'command'
    const key = plugin ? `plugin-${plugin.id}` : `${command!.source}-${command!.name}-${command!.sourceInfo.path}`
    const commandTitle =
      command?.source === 'builtin' ? (builtinCommandLabels[command.name] ?? `/${command.name}`) : `/${command?.name}`
    const commandIcon = command?.source === 'builtin' ? builtinCommandIcons[command.name] : undefined
    const title =
      plugin?.name ?? (resource ? (command!.displayName ?? command!.name.replace(/^skill:/, '')) : commandTitle)
    const description =
      plugin?.description ?? (resource ? (command?.shortDescription ?? command?.description) : command?.description)
    const disabled = Boolean(plugin && agentPlugins?.disabledReason)
    const button = (
      <button
        key={key}
        id={`composer-option-${index}`}
        type="button"
        tabIndex={-1}
        role="option"
        aria-selected={index === suggestionIndex}
        aria-disabled={disabled || undefined}
        title={disabled ? agentPlugins?.disabledReason : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!disabled) onComplete(item)
        }}
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-foreground transition-colors cursor-pointer select-none text-left',
          index === suggestionIndex ? 'bg-secondary font-medium' : 'hover:bg-secondary/60',
          disabled && 'opacity-50 cursor-not-allowed hover:bg-transparent',
        )}
      >
        <div className="flex flex-1 items-center gap-2 min-w-0">
          {commandIcon ? (
            <img
              src={commandIcon}
              alt=""
              width={24}
              height={24}
              draggable={false}
              className="size-6 shrink-0 object-contain"
            />
          ) : (
            resource &&
            (plugin?.iconUrl ? (
              <img src={plugin.iconUrl} alt="" className="size-4 shrink-0 object-contain" />
            ) : (
              <Box className="size-4 shrink-0 text-muted-foreground" />
            ))
          )}
          <span className={cn('min-w-0 truncate font-medium', resource && 'max-w-[45%] shrink-0')}>{title}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{description}</span>
        </div>
        {item.kind === 'skill' && command && (
          <span className="shrink-0 text-muted-foreground">
            {command.builtin
              ? '内置'
              : { user: '本地文件', project: '项目', temporary: '临时' }[command.sourceInfo.scope]}
          </span>
        )}
        {item.kind === 'command' && command && (
          <Badge variant="outline" className="text-[0.625rem] py-0 px-1.5 shrink-0">
            {{ builtin: '内置', extension: '扩展', prompt: '提示词', skill: '技能' }[command.source]}
          </Badge>
        )}
      </button>
    )
    return item.kind === 'skill' && command ? (
      <Tooltip key={key} delayDuration={300}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          side={placement === 'bottom' ? 'bottom' : 'top'}
          className="max-w-[min(32rem,calc(100vw-2rem))] break-all rounded-xl px-4 py-2 text-center font-mono text-sm"
        >
          {command.sourceInfo.path}
        </TooltipContent>
      </Tooltip>
    ) : (
      button
    )
  }

  const commands = matches.flatMap((item, index) => (item.kind === 'command' ? [option(item, index)] : []))
  const skills = matches.flatMap((item, index) => (item.kind === 'skill' ? [option(item, index)] : []))
  const plugins = matches.flatMap((item, index) => (item.kind === 'plugin' ? [option(item, index)] : []))
  return (
    <div
      ref={ref}
      className={cn(
        'absolute left-0 right-0 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-1.5 shadow-xl z-30',
        placement === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
      )}
      id="composer-suggestions"
      role="listbox"
      style={{ scrollbarWidth: 'thin', maxHeight: maxHeight ?? 'min(22rem,50vh)' }}
      aria-label={skillCompletion ? '技能选择' : '命令、技能与插件选择'}
    >
      {skillCompletion ? (
        skills.length ? (
          skills
        ) : (
          <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
            没有匹配的技能
          </div>
        )
      ) : (
        <>
          {commands}
          <div role="group" aria-label="技能">
            <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">技能</div>
            {skills.length ? (
              skills
            ) : (
              <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
                没有匹配的技能
              </div>
            )}
          </div>
          <div role="group" aria-label="插件">
            <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">插件</div>
            {plugins.length ? (
              plugins
            ) : (
              <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
                {agentPlugins?.loading ? '正在读取插件…' : '没有匹配的 Agent 插件'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
