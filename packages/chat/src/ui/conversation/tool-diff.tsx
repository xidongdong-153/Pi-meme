import * as React from 'react'
import { cn } from '@pi-meme/ui/lib/utils'

export function ToolDiff({ diff }: { diff: string }) {
  const lines = React.useMemo(() => diff.split('\n'), [diff])
  return (
    <pre className="pi-code-text [--code-size:0.75rem] font-mono text-xs leading-relaxed select-text">
      {lines.map((line, idx) => {
        let lineClass = 'text-muted-foreground'
        let marker = ' '
        let content = line

        if (line.startsWith('+') && !line.startsWith('+++')) {
          lineClass = 'bg-emerald-500/10 text-emerald-400 font-mono'
          marker = '+'
          content = line.slice(1)
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          lineClass = 'bg-rose-500/10 text-rose-400 font-mono'
          marker = '-'
          content = line.slice(1)
        } else if (line.startsWith('@@')) {
          lineClass = 'text-primary/80 font-mono'
          marker = ''
          content = line
        }

        return (
          <div key={idx} className={cn('flex items-start px-1 py-0.5 rounded-xs', lineClass)}>
            {marker ? (
              <span className="w-3.5 shrink-0 select-none opacity-70 text-center font-mono">{marker}</span>
            ) : null}
            <span className="flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{content || ' '}</span>
          </div>
        )
      })}
    </pre>
  )
}
