import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'

const navigationButtonClassName =
  'size-6 p-0 text-muted-foreground hover:text-foreground disabled:text-muted-foreground/30 disabled:opacity-30'

export function PageHeader({ children }: { children: ReactNode }) {
  return (
    <header className="workspace-topbar window-drag relative z-30 flex h-10 shrink-0 select-none bg-transparent pr-2">
      {children}
    </header>
  )
}

export function PageHeaderNavigation({
  nativeWindow,
  back,
}: {
  nativeWindow: boolean
  back?: {
    label: string
    onClick: () => void
    disabled?: boolean
    autoFocus?: boolean
  }
}) {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent)
  const backDisabled = !back || back.disabled

  return (
    <div className="no-drag flex h-full min-w-0 shrink-0 items-center gap-1.5 pl-3">
      {nativeWindow && isMac && <div className="w-[74px] shrink-0" aria-hidden="true" />}
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn('inline-flex', backDisabled && 'cursor-not-allowed')}
              tabIndex={backDisabled ? 0 : undefined}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={back?.label ?? '后退'}
                onClick={back?.onClick}
                disabled={backDisabled}
                autoFocus={back?.autoFocus}
                className={navigationButtonClassName}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{backDisabled ? '暂无可返回的页面' : back.label}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-not-allowed" tabIndex={0}>
              <Button variant="ghost" size="icon-sm" disabled aria-label="前进" className={navigationButtonClassName}>
                <ChevronRight className="size-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">暂无可前进的页面</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
