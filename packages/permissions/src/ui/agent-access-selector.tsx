import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  agentAccessChoices,
  defaultAccessMode,
  isAgentAccessMode,
  type AgentAccessMode,
} from '@pi-meme/contracts/agent-access'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@pi-meme/ui/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

const icons = { 'read-only': Shield, 'workspace-write': ShieldCheck, 'full-access': ShieldAlert } as const

const choices = agentAccessChoices.map((choice) => ({ ...choice, icon: icons[choice.mode] }))

export function AgentAccessSelector({
  mode = defaultAccessMode,
  busy,
  supported,
  onChange,
  compact = false,
}: {
  mode?: AgentAccessMode
  busy: boolean
  supported: boolean
  onChange: (mode: AgentAccessMode) => void
  compact?: boolean
}) {
  const selected = choices.find((choice) => choice.mode === mode)!
  const Icon = selected.icon
  return (
    <Select
      value={mode}
      disabled={busy}
      onValueChange={(value) => {
        if (isAgentAccessMode(value)) onChange(value)
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 whitespace-nowrap">
            <SelectTrigger
              aria-label="Agent 访问权限"
              iconClassName={compact ? 'hidden' : 'hidden @min-[500px]:block'}
              className={cn(
                'h-7 w-7 p-0 justify-center border-0 rounded-full text-xs shadow-none focus-visible:ring-2 focus-visible:ring-ring @min-[500px]:w-auto @min-[500px]:px-2 @min-[500px]:py-0.5 @min-[500px]:gap-1 transition-colors cursor-pointer',
                mode === 'full-access'
                  ? 'text-[#e58a4e] bg-[#e58a4e]/10 hover:bg-[#e58a4e]/20'
                  : 'text-muted-foreground hover:bg-secondary/40',
                compact && '@min-[500px]:w-7 @min-[500px]:p-0 @min-[500px]:gap-0',
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className={compact ? 'sr-only' : 'hidden @min-[500px]:inline'}>{selected.label}</span>
            </SelectTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{busy ? '任务结束后可切换权限' : selected.description}</TooltipContent>
      </Tooltip>
      <SelectContent side="top" align="start" className="w-[360px] rounded-2xl border-border/80 shadow-xl">
        <SelectGroup>
          <SelectLabel className="px-3 font-normal">Agent 访问权限</SelectLabel>
          {choices.map((choice) => (
            <SelectItem
              key={choice.mode}
              value={choice.mode}
              textValue={choice.label}
              disabled={!supported && choice.mode !== 'full-access'}
              className="rounded-xl py-2.5"
            >
              <span className="flex gap-2">
                <choice.icon className="mt-0.5 size-4 shrink-0" />
                <span className="flex flex-col gap-1">
                  <span className="font-medium">{choice.label}</span>
                  <span className="text-xs text-muted-foreground">{choice.description}</span>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
