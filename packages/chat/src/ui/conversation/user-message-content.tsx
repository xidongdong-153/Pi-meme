import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Box, ChevronDown } from 'lucide-react'
import { skillMessageParts } from '@pi-meme/contracts/skills'
import { cn } from '@pi-meme/ui/lib/utils'

export function UserMessageContent({ text }: { text: string }) {
  const contentId = useId()
  const content = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      setOverflowing(element.scrollHeight > lineHeight * 12 + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  return (
    <div className="min-w-0 max-w-full [overflow-wrap:anywhere]">
      <div id={contentId} ref={content} className={cn('pi-content', !expanded && 'max-h-[12lh] overflow-hidden')}>
        {skillMessageParts(text).map((part, index) =>
          part.type === 'text' ? (
            part.text
          ) : (
            <span key={index} title={part.path} className="inline text-blue-400" aria-label={`技能：${part.name}`}>
              <Box aria-hidden="true" className="inline-block size-4 align-[-0.125em] mr-1" />${part.name}
            </span>
          ),
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
          className="mt-2 inline-flex cursor-pointer items-center gap-1 text-xs text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          {expanded ? '收起' : '显示更多'}
          <ChevronDown
            className={cn(
              'size-3.5 transition-[rotate] duration-200 ease-out motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
          />
        </button>
      )}
    </div>
  )
}
