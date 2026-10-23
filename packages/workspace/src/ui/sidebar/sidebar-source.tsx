import { Globe } from 'lucide-react'

export type SidebarSource = {
  label: string
  description: string
  connected: boolean
  disabledReason?: string
}

export function SidebarSourceBadge({ source }: { source: SidebarSource }) {
  return (
    <span
      role="img"
      aria-label={`远程：${source.label}`}
      title={source.description}
      className="inline-flex shrink-0 items-center text-primary"
    >
      <Globe aria-hidden="true" className="size-3" />
    </span>
  )
}
