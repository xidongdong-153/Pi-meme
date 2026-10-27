import { Suspense, type ReactNode } from 'react'

export function SchedulesWorkspace({
  header,
  rail,
  children,
}: {
  header: ReactNode
  rail: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label="定时任务页面"
      className="workspace-panes flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary"
    >
      {header}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {rail}
        <Suspense
          fallback={
            <div className="content-frame bg-background">
              <div role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                正在打开定时任务…
              </div>
            </div>
          }
        >
          {children}
        </Suspense>
      </div>
    </section>
  )
}
