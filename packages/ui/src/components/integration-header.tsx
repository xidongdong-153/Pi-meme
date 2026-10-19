import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Input } from './ui/input'

export function IntegrationHeader({
  actions,
  children,
  query,
  onQuery,
  searchLabel,
  title,
  description,
}: {
  actions: ReactNode
  children?: ReactNode
  query: string
  onQuery: (value: string) => void
  searchLabel: string
  title?: string
  description?: string
}) {
  const search = (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
      <Input
        aria-label={searchLabel}
        placeholder={searchLabel}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        className="bg-card pl-9 shadow-none"
      />
    </div>
  )
  const actionRow = <div className="flex flex-wrap items-center gap-2">{actions}</div>
  if (title) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-48 sm:w-56">{search}</div>
            {actionRow}
          </div>
        </div>
        {children}
      </div>
    )
  }
  if (!children) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {search}
        {actionRow}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">{children}</div>
        {actionRow}
      </div>
      {search}
    </div>
  )
}
