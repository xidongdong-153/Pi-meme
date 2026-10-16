import * as React from 'react'
import { Brain, Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search, X } from 'lucide-react'
import type { PiModel, ThinkingLevel } from '@pi-meme/contracts/pi'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { DEFAULT_THINKING_LEVELS, THINKING_LEVEL_LABELS } from './thinking-config'

export type ModelPickerPopoverProps = {
  models: PiModel[]
  currentModel?: PiModel
  thinkingLevel?: ThinkingLevel
  availableThinkingLevels?: ThinkingLevel[]
  disabled: boolean
  onSelectModel: (model: PiModel) => void
  onSelectThinkingLevel: (level: ThinkingLevel) => void
}

export function ModelPickerPopover({
  models,
  currentModel,
  thinkingLevel = 'medium',
  availableThinkingLevels = [],
  disabled,
  onSelectModel,
  onSelectThinkingLevel,
}: ModelPickerPopoverProps) {
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<'thinking' | 'models'>('thinking')
  const [query, setQuery] = React.useState('')
  const [showSearch, setShowSearch] = React.useState(false)

  // 可用思考档位过滤（若无则退回默认 5 挡）
  const activeLevels = React.useMemo(() => {
    if (availableThinkingLevels && availableThinkingLevels.length > 0) {
      return availableThinkingLevels
    }
    return DEFAULT_THINKING_LEVELS
  }, [availableThinkingLevels])

  const currentIndex = React.useMemo(() => {
    const idx = activeLevels.indexOf(thinkingLevel)
    return idx >= 0 ? idx : Math.min(2, activeLevels.length - 1)
  }, [activeLevels, thinkingLevel])

  const modelKey = (m: PiModel) => `${m.provider}:${m.id}`
  const choices = React.useMemo(() => {
    if (!currentModel) return models
    if (!models.some((m) => modelKey(m) === modelKey(currentModel))) {
      return [currentModel, ...models]
    }
    return models
  }, [models, currentModel])
  const search = query.trim().toLocaleLowerCase()
  const filteredChoices = choices.filter((model) =>
    [model.name, model.id, model.provider].some((value) => value?.toLocaleLowerCase().includes(search)),
  )

  const displayName = currentModel?.name || currentModel?.id || '选择模型'
  const currentLevelLabel = THINKING_LEVEL_LABELS[thinkingLevel] || '中'

  // 处理滑块拖动或点击
  const trackRef = React.useRef<HTMLDivElement>(null)
  const isDragging = React.useRef(false)

  const updateFromPosition = React.useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || activeLevels.length <= 1) return
      const rect = track.getBoundingClientRect()
      // 轨道左右留有 padding 12px（白圈半径 12px），有效可滑动中心范围在 [12px, rect.width - 12px]
      const padding = 12
      const trackWidth = rect.width - padding * 2
      if (trackWidth <= 0) return
      const offset = clientX - rect.left - padding
      const ratio = Math.max(0, Math.min(1, offset / trackWidth))
      const targetIndex = Math.round(ratio * (activeLevels.length - 1))
      const nextLevel = activeLevels[targetIndex]
      if (nextLevel && nextLevel !== thinkingLevel) {
        onSelectThinkingLevel(nextLevel)
      }
    },
    [activeLevels, thinkingLevel, onSelectThinkingLevel],
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    isDragging.current = true
    updateFromPosition(event.clientX)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging.current) {
      updateFromPosition(event.clientX)
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging.current) {
      isDragging.current = false
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // 默认级别重置
  const handleResetLevel = () => {
    const defaultLevel = activeLevels.includes('medium') ? 'medium' : activeLevels[0] || 'off'
    onSelectThinkingLevel(defaultLevel)
  }

  // 当前激活比例（0 到 1）
  const ratio = activeLevels.length > 1 ? currentIndex / (activeLevels.length - 1) : 0.5

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setQuery('')
          setShowSearch(false)
          setView('thinking')
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="选择模型与思考强度"
          title={`${displayName} · ${currentLevelLabel}`}
          className={cn(
            'inline-flex min-w-0 max-w-full whitespace-nowrap items-center justify-center select-none cursor-pointer transition-colors rounded-full',
            'bg-secondary/60 hover:bg-secondary text-foreground/90 hover:text-foreground',
            'size-7 p-0 @min-[500px]:h-auto @min-[500px]:w-auto @min-[500px]:px-2.5 @min-[500px]:py-1 @min-[500px]:text-xs @min-[500px]:font-normal @min-[500px]:gap-1.5',
            disabled && 'cursor-not-allowed opacity-60',
            open && 'bg-secondary text-foreground',
          )}
        >
          {/* 窄视口或窄容器：仅显示大脑图标（参考 GPT） */}
          <Brain className="size-4 shrink-0 @min-[500px]:hidden text-foreground/80" />

          {/* 宽容器：显示模型名称、思考强度与下拉箭头 */}
          <div className="hidden min-w-0 @min-[500px]:inline-flex items-center gap-1.5">
            {open && view === 'thinking' ? (
              <span className="truncate font-normal">选择强度</span>
            ) : (
              <div className="flex min-w-0 items-center gap-1 max-w-[160px]">
                <span className="min-w-0 truncate">{displayName}</span>
                <span className="text-muted-foreground shrink-0 text-[0.6875rem]">{currentLevelLabel}</span>
              </div>
            )}
            <ChevronDown className="size-3 text-muted-foreground/80 shrink-0 ml-0.5" />
          </div>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        avoidCollisions={true}
        className="flex max-h-[min(24rem,calc(100vh-100px))] max-w-[calc(100vw-24px)] flex-col rounded-2xl p-3 bg-popover/95 backdrop-blur-md shadow-2xl border-border/80 w-64 select-none"
      >
        {view === 'thinking' ? (
          /* 图 1：思考强度配置面板 */
          <div className="flex flex-col gap-3 select-none">
            {/* 顶栏：中间高亮强度文字与模型入口，右侧重置按钮 */}
            <div className="flex items-center justify-between px-1">
              <div className="size-6" />
              <div className="flex flex-col items-center">
                <span className="text-sm font-semibold text-blue-500 tracking-wide leading-tight">
                  {currentLevelLabel}
                </span>
                <button
                  type="button"
                  onClick={() => setView('models')}
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer mt-0.5"
                >
                  <span className="truncate max-w-[150px]">{displayName}</span>
                  <ChevronRight className="size-3 shrink-0" />
                </button>
              </div>
              <button
                type="button"
                onClick={handleResetLevel}
                aria-label="重置思考强度"
                title="重置为默认强度"
                className="flex size-6 items-center justify-center text-muted-foreground/70 hover:text-foreground transition-colors rounded-md hover:bg-secondary/60 cursor-pointer"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>

            {/* 步进滑块 Stepper Slider：胶囊轨道与纯白小球 Thumb */}
            <div className="px-1 py-0.5">
              <div
                ref={trackRef}
                role="slider"
                aria-label="思考强度滑块"
                aria-valuemin={0}
                aria-valuemax={activeLevels.length - 1}
                aria-valuenow={currentIndex}
                aria-valuetext={currentLevelLabel}
                tabIndex={0}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className="relative flex items-center w-full py-1.5 cursor-pointer touch-none select-none"
              >
                {/* 轨道层：高 24px，半透明底，rounded-full 且 overflow-hidden */}
                <div className="relative h-6 w-full rounded-full bg-white/10 flex items-center overflow-hidden">
                  {/* 激活段蓝色填充：最低(关)时无蓝色，拉满时100%全满圆角，中间时右端平直连接白圈中心 */}
                  <div
                    className={cn(
                      'absolute left-0 top-0 bottom-0 bg-blue-600 rounded-l-full transition-[width] duration-200 ease-out motion-reduce:transition-none',
                      activeLevels.length > 1 && currentIndex === activeLevels.length - 1
                        ? 'rounded-r-full'
                        : 'rounded-r-none',
                    )}
                    style={{
                      width:
                        currentIndex === 0
                          ? '0px'
                          : activeLevels.length > 1 && currentIndex === activeLevels.length - 1
                            ? '100%'
                            : `calc(12px + ${ratio} * (100% - 24px))`,
                    }}
                  />

                  {/* 各档位刻度点（与滑块停靠中心完全重合） */}
                  {activeLevels.map((lvl, index) => {
                    const r = activeLevels.length > 1 ? index / (activeLevels.length - 1) : 0.5
                    const isPassed = index < currentIndex
                    return (
                      <div
                        key={lvl}
                        style={{
                          left: `calc(12px + ${r} * (100% - 24px))`,
                        }}
                        className={cn(
                          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 size-1 rounded-full pointer-events-none transition-colors',
                          isPassed ? 'bg-white/80' : 'bg-white/25',
                        )}
                      />
                    )
                  })}
                </div>

                {/* 白色圆形滑块 Thumb：直径 24px，完整覆盖轨道两端 */}
                <div
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 size-6 rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.35),0_1px_2px_rgba(0,0,0,0.2)] transition-[left] duration-200 ease-out motion-reduce:transition-none pointer-events-none"
                  style={{
                    left: `calc(12px + ${ratio} * (100% - 24px))`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          /* 图 2：选择模型面板 */
          <div className="flex min-h-0 flex-col gap-2 select-none">
            {/* 顶栏：左侧返回箭头 + 标题层级（选择模型/默认/推荐模型集），右侧按需提供搜索开关 */}
            <div className="flex items-start justify-between px-1 pb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <button
                  type="button"
                  onClick={() => setView('thinking')}
                  aria-label="返回思考设置"
                  className="text-muted-foreground hover:text-foreground p-1 -ml-1 rounded-md hover:bg-secondary/60 cursor-pointer shrink-0 transition-colors"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <div className="flex flex-col min-w-0">
                  <span className="text-[0.6875rem] text-muted-foreground leading-tight">选择模型</span>
                  <span className="text-xs font-semibold text-foreground truncate leading-tight mt-0.5">
                    {currentModel?.provider
                      ? currentModel.provider.charAt(0).toUpperCase() + currentModel.provider.slice(1)
                      : '默认'}
                  </span>
                  <span className="text-[0.625rem] text-muted-foreground/70 leading-tight">推荐模型集</span>
                </div>
              </div>
              {choices.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowSearch((prev) => !prev)}
                  aria-label="搜索模型"
                  className={cn(
                    'text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-secondary/60 cursor-pointer shrink-0 transition-colors mt-0.5',
                    (showSearch || query) && 'text-foreground bg-secondary/60',
                  )}
                >
                  <Search className="size-3.5" />
                </button>
              )}
            </div>

            {/* 可选展开的紧凑搜索栏 */}
            {(showSearch || query) && (
              <div className="relative shrink-0 px-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="搜索模型"
                  placeholder="搜索模型..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-7 rounded-md bg-secondary/30 pr-7 pl-7 text-xs focus-visible:ring-1 focus-visible:ring-ring"
                  autoFocus
                />
                {query && (
                  <button
                    type="button"
                    aria-label="清空模型搜索"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            )}

            {/* 单行模型列表：紧凑清晰，选中的带 Check 勾选 */}
            <div
              role="region"
              aria-label="可用模型"
              tabIndex={0}
              className="min-h-0 max-h-60 overflow-y-auto overscroll-contain space-y-0.5 px-0.5 outline-none rounded-lg"
            >
              {filteredChoices.map((model) => {
                const isSelected = currentModel && modelKey(model) === modelKey(currentModel)
                return (
                  <button
                    key={modelKey(model)}
                    type="button"
                    onClick={() => {
                      onSelectModel(model)
                      setView('thinking')
                    }}
                    className={cn(
                      'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer text-left',
                      isSelected
                        ? 'bg-secondary/70 text-foreground font-medium'
                        : 'text-foreground/90 hover:bg-secondary/40 hover:text-foreground',
                    )}
                  >
                    <span className="truncate pr-2">{model.name ?? model.id}</span>
                    {isSelected && <Check className="size-3.5 text-foreground shrink-0" />}
                  </button>
                )
              })}
              {!filteredChoices.length && (
                <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {search ? '没有匹配的模型' : '暂无可用模型'}
                </p>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
