import * as React from 'react'
import { Brain, Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search, X } from 'lucide-react'
import { modelThinkingLevels, resolveThinkingLevel, type PiModel, type ThinkingLevel } from '@pi-meme/contracts/pi'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { THINKING_LEVEL_LABELS } from './thinking-config'

const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  'github-copilot': 'GitHub Copilot',
}

function formatProviderName(provider?: string): string {
  if (!provider) return '默认'
  const normalized = provider.toLowerCase()
  if (KNOWN_PROVIDER_LABELS[normalized]) {
    return KNOWN_PROVIDER_LABELS[normalized]
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export type ModelPickerPopoverProps = {
  models: PiModel[]
  currentModel?: PiModel
  thinkingLevel?: ThinkingLevel
  disabled: boolean
  busy?: boolean
  openModelsVersion?: number
  shortcutLabel?: string
  onSelectModel: (model: PiModel) => void
  onSelectThinkingLevel: (level: ThinkingLevel) => void
}

type SliderGesture = {
  pointerId: number
  left: number
  width: number
  offset: number
  startX: number
  dragging: boolean
}

export function ModelPickerPopover({
  models,
  currentModel,
  thinkingLevel = 'medium',
  disabled,
  busy = false,
  openModelsVersion,
  shortcutLabel,
  onSelectModel,
  onSelectThinkingLevel,
}: ModelPickerPopoverProps) {
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<'thinking' | 'models'>('thinking')
  const [query, setQuery] = React.useState('')
  const [showSearch, setShowSearch] = React.useState(false)

  const [dragRatio, setDragRatio] = React.useState<number | null>(null)
  const isDragging = dragRatio !== null

  const selectedModel =
    models.find((model) => model.provider === currentModel?.provider && model.id === currentModel.id) ?? currentModel
  const activeLevels = modelThinkingLevels(selectedModel)
  const currentIndex = activeLevels.indexOf(resolveThinkingLevel(selectedModel, thinkingLevel))

  // 离散步进比例
  const stepRatio = activeLevels.length > 1 ? currentIndex / (activeLevels.length - 1) : 0.5
  // 渲染时使用的实际比例（拖拽时连续跟随手指，松手吸附到档位）
  const activeRatio = dragRatio ?? stepRatio

  // 实时根据 activeRatio 计算当前高亮的档位索引（用于拖拽时上方文字和刻度实时高亮）
  const activeIndex =
    dragRatio !== null
      ? Math.max(0, Math.min(activeLevels.length - 1, Math.round(dragRatio * (activeLevels.length - 1))))
      : currentIndex

  const activeLevel = activeLevels[activeIndex] || thinkingLevel
  const currentLevelLabel = THINKING_LEVEL_LABELS[activeLevel] || '中'

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
  const groups = React.useMemo(() => {
    const map = new Map<string, PiModel[]>()
    for (const model of filteredChoices) {
      const provider = model.provider || 'default'
      const list = map.get(provider)
      if (list) {
        list.push(model)
      } else {
        map.set(provider, [model])
      }
    }
    return Array.from(map.entries()).map(([provider, items]) => ({
      provider,
      name: formatProviderName(provider),
      models: items,
    }))
  }, [filteredChoices])

  const displayName = currentModel?.name || currentModel?.id || '选择模型'

  // 处理滑块拖动或点击
  const trackRef = React.useRef<HTMLDivElement>(null)
  const thumbRef = React.useRef<HTMLDivElement>(null)
  const gestureRef = React.useRef<SliderGesture | null>(null)

  const getPointerRatio = (clientX: number, gesture: SliderGesture) =>
    Math.max(0, Math.min(1, (clientX - gesture.left - gesture.offset) / gesture.width))

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || busy || activeLevels.length <= 1 || event.button !== 0 || gestureRef.current) return
    const track = trackRef.current?.getBoundingClientRect()
    const thumb = thumbRef.current?.getBoundingClientRect()
    if (!track || !thumb || track.width <= 24) return
    const onThumb = event.clientX >= thumb.left && event.clientX <= thumb.right
    const gesture: SliderGesture = {
      pointerId: event.pointerId,
      left: track.left + 12,
      width: track.width - 24,
      offset: onThumb ? event.clientX - (thumb.left + thumb.width / 2) : 0,
      startX: event.clientX,
      dragging: onThumb,
    }
    gestureRef.current = gesture
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    if (onThumb) setDragRatio(getPointerRatio(event.clientX, gesture))
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || disabled || busy) return
    if (!gesture.dragging && Math.abs(event.clientX - gesture.startX) < 3) return
    gesture.dragging = true
    setDragRatio(getPointerRatio(event.clientX, gesture))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    setDragRatio(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (disabled || busy || activeLevels.length <= 1) return
    const ratio = getPointerRatio(event.clientX, gesture)
    const targetIndex = Math.round(ratio * (activeLevels.length - 1))
    const nextLevel = activeLevels[targetIndex] || thinkingLevel
    if (nextLevel !== thinkingLevel) {
      onSelectThinkingLevel(nextLevel)
    }
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return
    gestureRef.current = null
    setDragRatio(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || busy || activeLevels.length <= 1) return
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      nextIndex = Math.min(activeLevels.length - 1, currentIndex + 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      nextIndex = Math.max(0, currentIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      nextIndex = 0
    } else if (event.key === 'End') {
      event.preventDefault()
      nextIndex = activeLevels.length - 1
    } else {
      return
    }
    const nextLevel = activeLevels[nextIndex]
    if (nextLevel && nextLevel !== thinkingLevel) {
      onSelectThinkingLevel(nextLevel)
    }
  }

  // 默认级别重置
  const handleResetLevel = () => {
    onSelectThinkingLevel(resolveThinkingLevel(selectedModel, 'medium'))
  }

  React.useEffect(() => {
    if (openModelsVersion && openModelsVersion > 0 && !disabled && !busy) {
      setView('models')
      setQuery('')
      setShowSearch(false)
      setOpen(true)
    }
  }, [openModelsVersion, disabled, busy])

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        gestureRef.current = null
        setDragRatio(null)
        if (nextOpen) {
          setQuery('')
          setShowSearch(false)
          setView('thinking')
        }
        setOpen(nextOpen)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-busy={busy || undefined}
          aria-label="选择模型与思考强度"
          title={`${displayName} · ${currentLevelLabel}${shortcutLabel ? `（${shortcutLabel}）` : ''}`}
          className={cn(
            'inline-flex min-w-0 max-w-full whitespace-nowrap items-center justify-center select-none cursor-pointer transition-colors rounded-full',
            'bg-secondary/60 hover:bg-secondary text-foreground/90 hover:text-foreground',
            'size-7 p-0 @min-[500px]:h-7 @min-[500px]:w-auto @min-[500px]:px-2.5 @min-[500px]:text-xs @min-[500px]:font-normal @min-[500px]:gap-1.5',
            disabled && 'cursor-not-allowed opacity-60',
            open && 'bg-secondary text-foreground',
          )}
        >
          {/* 窄视口或窄容器：仅显示大脑图标（参考 GPT） */}
          <Brain className="size-4 shrink-0 @min-[500px]:hidden text-foreground/80" />

          {/* 宽容器：稳定显示模型名称、思考强度与下拉箭头，结构稳定不突变 */}
          <div className="hidden min-w-0 @min-[500px]:inline-flex items-center gap-1.5">
            <div className="flex min-w-0 items-center gap-1 max-w-[160px]">
              <span className="min-w-0 truncate">{displayName}</span>
              <span className="w-[2em] text-center text-muted-foreground shrink-0 text-[0.6875rem]">
                {currentLevelLabel}
              </span>
            </div>
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
        className="flex max-h-[min(24rem,calc(100vh-100px))] w-64 max-w-[calc(100vw-24px)] flex-col rounded-2xl border-border/80 bg-popover p-3 shadow-xl select-none"
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
                  aria-label="切换模型"
                  className="group mt-1 inline-flex items-center gap-0.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                >
                  <span className="truncate max-w-[160px]">{displayName}</span>
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground/70 group-hover:text-foreground transition-colors" />
                </button>
              </div>
              <button
                type="button"
                onClick={handleResetLevel}
                disabled={disabled || busy}
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
                aria-valuenow={activeIndex}
                aria-valuetext={currentLevelLabel}
                aria-disabled={disabled || busy || activeLevels.length <= 1}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onLostPointerCapture={() => {
                  if (!gestureRef.current) return
                  gestureRef.current = null
                  setDragRatio(null)
                }}
                className="relative flex items-center w-full py-1.5 cursor-pointer touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded-full"
              >
                {/* 轨道层：高 24px，圆球两侧各留 12px。 */}
                <div className="relative h-6 w-full rounded-full bg-white/10 flex items-center">
                  {/* 填充条和圆球共用右边界，只对填充宽度做动画。 */}
                  <div
                    className={cn(
                      'absolute left-0 top-0 bottom-0 rounded-l-full',
                      activeLevels.length > 1 && 'bg-blue-600',
                      isDragging
                        ? 'transition-none'
                        : 'transition-[width] duration-150 ease-out motion-reduce:transition-none',
                    )}
                    style={{
                      width: `calc(12px + ${activeRatio} * (100% - 24px))`,
                    }}
                  >
                    <div
                      ref={thumbRef}
                      className="absolute -right-3 top-0 z-20 size-6 rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.35),0_1px_2px_rgba(0,0,0,0.2)] pointer-events-none"
                    />
                  </div>

                  {/* 各档位刻度点（与滑块停靠中心完全重合） */}
                  {activeLevels.map((lvl, index) => {
                    const r = activeLevels.length > 1 ? index / (activeLevels.length - 1) : 0.5
                    const isPassed = index < activeIndex
                    return (
                      <div
                        key={lvl}
                        style={{
                          left: `calc(12px + ${r} * (100% - 24px))`,
                        }}
                        className={cn(
                          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 size-1 rounded-full pointer-events-none transition-colors duration-150',
                          isPassed ? 'bg-white/80' : 'bg-white/25',
                        )}
                      />
                    )
                  })}
                </div>
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
                  <span className="text-xs font-semibold text-foreground truncate leading-tight mt-0.5">可用模型</span>
                  <span className="text-[0.625rem] text-muted-foreground/70 leading-tight truncate">
                    {currentModel ? `当前：${formatProviderName(currentModel.provider)}` : '按供应商分组'}
                  </span>
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

            {/* 单行模型列表：按供应商分组，选中的带 Check 勾选 */}
            <div
              role="region"
              aria-label="可用模型"
              tabIndex={0}
              className="min-h-0 max-h-60 overflow-y-auto overscroll-contain space-y-0.5 px-0.5 outline-none rounded-lg"
            >
              {groups.map((group, groupIndex) => (
                <React.Fragment key={group.provider}>
                  <div
                    className={cn(
                      'px-2.5 pb-1 text-xs font-normal text-muted-foreground select-none',
                      groupIndex === 0 ? 'pt-1' : 'pt-2.5',
                    )}
                  >
                    {group.name}
                  </div>
                  {group.models.map((model) => {
                    const isSelected = currentModel && modelKey(model) === modelKey(currentModel)
                    return (
                      <button
                        key={modelKey(model)}
                        type="button"
                        disabled={disabled || busy}
                        onClick={() => {
                          setOpen(false)
                          onSelectModel(model)
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-sm transition-colors cursor-pointer',
                          isSelected
                            ? 'bg-secondary text-foreground font-medium'
                            : 'text-foreground/90 hover:bg-secondary/60 hover:text-foreground',
                        )}
                      >
                        <span className="truncate pr-2 pl-2">{model.name ?? model.id}</span>
                        {isSelected && <Check className="size-3.5 text-foreground shrink-0" />}
                      </button>
                    )
                  })}
                </React.Fragment>
              ))}
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
