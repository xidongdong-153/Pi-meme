import type { ComponentProps } from 'react'
import { Search } from 'lucide-react'
import { IntegrationHeader } from '@pi-meme/ui/components/integration-header'
import { Input } from '@pi-meme/ui/components/ui/input'

export function ResourceSettingsHeader(props: ComponentProps<typeof IntegrationHeader>) {
  if (props.title) return <IntegrationHeader {...props} />

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {props.children}
        <div className="flex max-w-full flex-wrap items-center gap-2">{props.actions}</div>
      </div>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
        />
        <Input
          aria-label={props.searchLabel}
          placeholder={props.searchLabel}
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          className="h-9 rounded-lg border-border/80 bg-secondary/50 pl-9 pr-3 text-xs shadow-none focus-visible:bg-secondary/80"
        />
      </div>
    </div>
  )
}
