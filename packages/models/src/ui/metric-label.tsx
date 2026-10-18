import { CircleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'

export function MetricLabel({ label, description }: { label: string; description: string }) {
  return (
    <span className="group/metric-label inline-flex items-center gap-1 whitespace-nowrap">
      <span>{label}</span>
      <Tooltip delayDuration={150} disableHoverableContent>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${label}说明`}
            className="pointer-events-none inline-flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground/60 opacity-0 transition-opacity duration-100 group-hover/metric-label:pointer-events-auto group-hover/metric-label:opacity-100 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <CircleAlert className="size-3" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={5} className="z-[60] max-w-64 text-xs font-normal leading-relaxed">
          {description}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
