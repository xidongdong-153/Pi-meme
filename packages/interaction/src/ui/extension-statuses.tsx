import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { Badge } from '@pi-meme/ui/components/ui/badge'

export function ExtensionStatusBadges({ statuses }: { statuses: Record<string, string> }) {
  if (!Object.keys(statuses).length) return null
  return (
    <div aria-label="扩展状态" className="mb-2 flex flex-wrap gap-1.5">
      {Object.entries(statuses).map(([key, value]) => (
        <TooltipHint key={key} content={key}>
          <Badge variant="secondary" className="text-[0.6875rem] font-normal">
            <span className="font-semibold mr-1">{key}:</span>
            {value}
          </Badge>
        </TooltipHint>
      ))}
    </div>
  )
}
