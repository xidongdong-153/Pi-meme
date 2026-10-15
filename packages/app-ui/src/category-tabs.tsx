import { cn } from '@pi-meme/ui/lib/utils'

export function CategoryTabs<T extends string>({
  label,
  idPrefix,
  value,
  onChange,
  options,
  controls,
}: {
  label: string
  idPrefix: string
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<{ id: T; label: string; count: number }>
  controls?: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-1">
      {options.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          id={`${idPrefix}-${entry.id}`}
          tabIndex={value === entry.id ? 0 : -1}
          aria-selected={value === entry.id}
          aria-controls={controls}
          onClick={() => onChange(entry.id)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = options.findIndex((option) => option.id === value)
            const next =
              event.key === 'Home'
                ? options[0]
                : event.key === 'End'
                  ? options[options.length - 1]
                  : options[(index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]
            onChange(next.id)
            document.getElementById(`${idPrefix}-${next.id}`)?.focus()
          }}
          className={cn(
            'rounded-xl px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === entry.id ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {entry.label}
          <span className="ml-2 text-muted-foreground">{entry.count}</span>
        </button>
      ))}
    </div>
  )
}
