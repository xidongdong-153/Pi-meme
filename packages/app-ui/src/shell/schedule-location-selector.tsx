import { ChevronDown, Globe, Monitor } from 'lucide-react'
import type { HostService } from '@pi-meme/contracts/host'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { serviceLabel, serviceStatus } from './service-ui'

export function ScheduleLocationSelector({
  services,
  serviceId,
  label,
  onSelect,
}: {
  services: HostService[]
  serviceId?: string
  label: string
  onSelect: (id: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="任务执行位置"
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-border/50 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {services.find((service) => service.id === serviceId)?.local ? (
            <Monitor className="size-3.5" />
          ) : (
            <Globe className="size-3.5" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-64">
        {services.length ? (
          services.map((service) => (
            <DropdownMenuItem
              key={service.id}
              disabled={service.status !== 'connected' || service.enabled === false}
              onClick={() => onSelect(service.id)}
            >
              <span className="min-w-0 flex-1 truncate">{serviceLabel(service)}</span>
              <span className="text-[11px] text-muted-foreground">{serviceStatus(service)}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>{label}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
