import { UserMessageContent } from '../conversation/user-message-content'
import { Trash2 } from 'lucide-react'
import type { ComposerProps } from './composer'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'

export function ComposerQueues({ queues, onClearQueue }: Pick<ComposerProps, 'queues' | 'onClearQueue'>) {
  const hasQueue = queues.steering.length > 0 || queues.followUp.length > 0
  return (
    <>
      {hasQueue && (
        <div
          aria-label="待处理任务队列"
          className="mt-2.5 rounded-lg border border-border/70 bg-secondary/30 p-2 text-xs"
        >
          <div className="flex items-center justify-between mb-1.5 font-medium text-muted-foreground">
            <span>待处理任务队列</span>
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-xs text-muted-foreground hover:text-destructive gap-1"
              onClick={onClearQueue}
            >
              <Trash2 className="size-3" />
              清空
            </Button>
          </div>
          <div className="space-y-1">
            {queues.steering.map((msg, idx) => (
              <div key={`steering-${idx}`} className="flex items-center gap-1.5 text-xs">
                <Badge variant="warning" className="text-[0.625rem] py-0 px-1 shrink-0">
                  插话
                </Badge>
                <div className="min-w-0 flex-1 text-foreground/90 [&>.pi-content]:truncate">
                  <UserMessageContent text={msg} />
                </div>
              </div>
            ))}
            {queues.followUp.map((msg, idx) => (
              <div key={`followUp-${idx}`} className="flex items-center gap-1.5 text-xs">
                <Badge variant="secondary" className="text-[0.625rem] py-0 px-1 shrink-0">
                  排队
                </Badge>
                <div className="min-w-0 flex-1 text-foreground/90 [&>.pi-content]:truncate">
                  <UserMessageContent text={msg} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
