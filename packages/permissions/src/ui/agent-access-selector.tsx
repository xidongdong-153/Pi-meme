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
  SelectSeparator,
  SelectTrigger,
} from '@pi-meme/ui/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

const icons = { 'read-only': Shield, 'workspace-write': ShieldCheck, 'full-access': ShieldAlert } as const

const choices = agentAccessChoices.map((choice) => ({ ...choice, icon: icons[choice.mode] }))

export function AgentAccessSelector({
  mode = defaultAccessMode,
  cwd,
  busy,
  supported,
  reason,
  onChange,
  compact = false,
}: {
  mode?: AgentAccessMode
  cwd: string
  busy: boolean
  supported: boolean
  reason?: string
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
                'h-7 w-7 p-0 justify-center border-0 text-xs shadow-none hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring @min-[500px]:w-auto @min-[500px]:px-1.5 @min-[500px]:py-0.5 @min-[500px]:gap-1',
                mode === 'full-access' ? 'text-[#e58a4e]' : 'text-muted-foreground',
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
      <SelectContent side="top" align="start" className="w-[360px]">
        <SelectGroup>
          <SelectLabel>Agent 访问权限</SelectLabel>
          {choices.map((choice) => (
            <SelectItem
              key={choice.mode}
              value={choice.mode}
              textValue={choice.label}
              disabled={!supported && choice.mode !== 'full-access'}
              className="py-2.5"
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
        <SelectSeparator />
        <div className="space-y-1 px-2 py-2 text-xs text-muted-foreground">
          <div className="break-all">当前项目：{cwd}</div>
          <div>受限模式不加载外部 Agent 插件</div>
          {!supported && <div>{reason ?? '所属 Host 的受限权限沙箱不可用，请检查系统依赖后重启 Host。'}</div>}
        </div>
      </SelectContent>
    </Select>
  )
}
