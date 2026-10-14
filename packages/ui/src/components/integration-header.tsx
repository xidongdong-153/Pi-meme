import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Input } from './ui/input'

export function IntegrationHeader({
  title,
  description,
  actions,
  children,
  query,
  onQuery,
  searchLabel,
}: {
  title: string
  description: string
  actions: ReactNode
  children?: ReactNode
  query: string
  onQuery: (value: string) => void
  searchLabel: string
}) {
  return (
    <header className="space-y-10">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-3 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>{children}</div>
        <div className="relative ml-auto w-full sm:w-72 lg:w-80">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-3 size-4 text-muted-foreground"
          />
          <Input
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            className="h-10 rounded-xl bg-secondary/60 pl-10"
          />
        </div>
      </div>
    </header>
  )
}
