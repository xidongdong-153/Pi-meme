import { BentoSkeletonBar, BentoSkeletonButton } from '@pi-meme/ui/components/bento-skeleton'
import { cn } from '@pi-meme/ui/lib/utils'

export function ProfileSkeleton({
  testId = 'settings-skeleton-profile',
  showHeader = true,
  className,
}: {
  testId?: string
  showHeader?: boolean
  className?: string
}) {
  return (
    <div
      aria-label="个人资料统计骨架"
      data-testid={testId}
      className={cn('@container min-w-0 space-y-10 animate-in fade-in-0 duration-150', className)}
    >
      {showHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <BentoSkeletonBar className="w-64 max-w-full" size="xs" />
          <BentoSkeletonButton className="h-7 w-16 rounded-md" />
        </div>
      )}

      {/* 指标卡片骨架：与真实 dl 容器 1:1 对位，消除卡片崩塌与边框跳动 */}
      <div
        className="grid grid-cols-2 gap-y-5 rounded-2xl border border-border bg-card/30 px-3 py-5 @min-[600px]:grid-cols-5"
        aria-hidden="true"
      >
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="flex min-w-0 flex-col items-center px-2 py-1 @min-[600px]:border-r @min-[600px]:border-border @min-[600px]:last:border-r-0"
          >
            <BentoSkeletonBar className="h-6 w-16" />
            <BentoSkeletonBar className="mt-2 w-20" size="xs" />
          </div>
        ))}
      </div>

      {/* 图表骨架：1:1 模拟 TokenActivity 7 行日历热力图网格与周期选择胶囊 */}
      <section className="min-w-0 space-y-5" aria-hidden="true">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1.5">
            <BentoSkeletonBar className="w-24" size="md" />
            <BentoSkeletonBar className="w-44" size="xs" />
          </div>
          <div className="flex gap-1 rounded-lg bg-secondary/50 p-1">
            <div className="h-6 w-12 rounded-md bg-card/80 shadow-xs" />
            <div className="h-6 w-12 rounded-md bg-transparent" />
            <div className="h-6 w-12 rounded-md bg-transparent" />
          </div>
        </div>

        <div className="overflow-x-auto pb-2">
          <div className="min-w-[680px] space-y-2">
            <div
              className="grid grid-flow-col grid-rows-7 gap-1"
              style={{ gridTemplateColumns: 'repeat(53, minmax(0, 1fr))' }}
            >
              {Array.from({ length: 53 * 7 }).map((_, index) => (
                <div
                  key={index}
                  className={cn(
                    'aspect-square rounded-xs bg-muted/40 transition-colors',
                    index % 11 === 0 && 'animate-pulse bg-muted/70',
                  )}
                />
              ))}
            </div>
            <div className="flex justify-between pt-1">
              {Array.from({ length: 12 }).map((_, index) => (
                <BentoSkeletonBar key={index} className="w-6" size="xs" />
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <BentoSkeletonBar className="w-44" size="xs" />
          <div className="flex items-center gap-1.5">
            <BentoSkeletonBar className="w-4" size="xs" />
            <div className="flex gap-1">
              <div className="size-3 rounded-xs bg-secondary" />
              <div className="size-3 rounded-xs bg-muted/60" />
              <div className="size-3 rounded-xs bg-muted/80" />
              <div className="size-3 rounded-xs bg-muted" />
            </div>
            <BentoSkeletonBar className="w-4" size="xs" />
          </div>
        </div>
      </section>

      {/* 底部信息占位，防止真实数据返回时高度下沉跳水 */}
      <div className="space-y-2" aria-hidden="true">
        <BentoSkeletonBar className="w-80 max-w-full" size="xs" />
      </div>
    </div>
  )
}
