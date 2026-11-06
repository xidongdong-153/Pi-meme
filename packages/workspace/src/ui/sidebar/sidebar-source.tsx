import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { Globe } from 'lucide-react'

export type SidebarSource = {
  label: string
  description: string
  connected: boolean
  disabledReason?: string
}

export function SidebarSourceBadge({ source }: { source: SidebarSource }) {
  return (
    <TooltipHint content={source.description}>
      <span
        role="img"
        aria-label={`远程：${source.label}`}
        className="inline-flex size-4 shrink-0 items-center justify-center text-primary"
      >
        <Globe aria-hidden="true" className="size-3" />
      </span>
    </TooltipHint>
  )
}
