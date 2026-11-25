import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import * as React from 'react'
import { Brain, Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search, X, Zap } from 'lucide-react'
import {
  modelSessionThinkingLevels,
  modelThinkingLevels,
  resolveModelThinkingLevel,
  resolveSessionThinkingLevel,
  type PiModel,
  type SessionThinkingLevel,
  type ServiceTier,
} from '@pi-meme/contracts/pi'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import { THINKING_LEVEL_LABELS } from './thinking-config'
import './model-picker-popover.css'

const ULTRA_DESCRIPTION = '最高可用思考强度与主动多代理协作，可能增加用量'

type ParticleProfile = {
  count: number
  speedPxPerSec: number
  sizeScale: number
  glowBlur: number
}

// 思考强度从低到高递进的粒子流配置（开启 Fast 模式时每一个思考强度均生效）
const FAST_PARTICLE_PROFILES: Record<SessionThinkingLevel, ParticleProfile> = {
  off: { count: 4, speedPxPerSec: 26, sizeScale: 0.85, glowBlur: 3 },
  minimal: { count: 5, speedPxPerSec: 36, sizeScale: 0.88, glowBlur: 3.5 },
  low: { count: 6, speedPxPerSec: 54, sizeScale: 0.94, glowBlur: 4 },
  medium: { count: 8, speedPxPerSec: 78, sizeScale: 1, glowBlur: 4.5 },
  high: { count: 10, speedPxPerSec: 110, sizeScale: 1.05, glowBlur: 5 },
  xhigh: { count: 12, speedPxPerSec: 148, sizeScale: 1.08, glowBlur: 5.5 },
  max: { count: 14, speedPxPerSec: 190, sizeScale: 1.12, glowBlur: 6 },
  ultra: { count: 16, speedPxPerSec: 232, sizeScale: 1.15, glowBlur: 6.5 },
}

// Ultra 未开启 Fast 时的基础星尘流配置（同样向左流动，节奏更克制优雅）
const ULTRA_BASE_PARTICLE_PROFILE: ParticleProfile = {
  count: 12,
  speedPxPerSec: 108,
  sizeScale: 1.05,
  glowBlur: 5,
}

// [top%, baseSizePx, phase(0~1), speedScale, driftYPx, opacity]
const FLOW_PARTICLES: readonly (readonly [number, number, number, number, number, number])[] = [
  [30, 2.4, 0.12, 1.12, -1.6, 0.9],
  [68, 1.8, 0.58, 0.86, 1.8, 0.72],
  [46, 2.8, 0.34, 1.2, -1.2, 0.95],
  [78, 1.6, 0.81, 0.82, -1.4, 0.65],
  [22, 2.2, 0.47, 1.04, 1.5, 0.84],
  [58, 2.6, 0.93, 1.15, -1.8, 0.88],
  [36, 1.7, 0.23, 0.88, 1.6, 0.68],
  [72, 2.5, 0.69, 1.1, -1.5, 0.86],
  [24, 3.0, 0.05, 1.24, 1.2, 0.96],
  [52, 1.9, 0.41, 0.92, -2.0, 0.75],
  [82, 2.2, 0.18, 1.02, -1.2, 0.8],
  [38, 2.7, 0.76, 1.18, 1.7, 0.92],
  [64, 1.6, 0.29, 0.84, 1.4, 0.64],
  [18, 2.4, 0.88, 1.14, 1.8, 0.88],
  [48, 3.1, 0.63, 1.26, -1.6, 0.96],
  [74, 2.0, 0.09, 0.96, -1.8, 0.78],
  [28, 1.7, 0.52, 0.85, 1.5, 0.68],
  [60, 2.6, 0.97, 1.22, -1.3, 0.9],
]

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
  mobile?: boolean
  models: PiModel[]
  currentModel?: PiModel
  thinkingLevel?: SessionThinkingLevel
  /** 仅聊天输入框开放 Ultra；模型默认、定时任务等配置继续使用原生档位。 */
  allowUltra?: boolean
  serviceTier?: ServiceTier
  onSelectServiceTier?: (tier: ServiceTier) => void
  nextMessageSpeed?: boolean
  disabled: boolean
  busy?: boolean
  active?: boolean
  openModelsVersion?: number
  shortcutLabel?: string
  onSelectModel: (model: PiModel) => void
  onSelectThinkingLevel: (level: SessionThinkingLevel) => void
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
  mobile = false,
  models,
  currentModel,
  thinkingLevel = 'medium',
  serviceTier = 'inherit',
  nextMessageSpeed,
  onSelectServiceTier,
  allowUltra = false,
  disabled,
  busy = false,
  active = true,
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
  const supportsFastMode = Boolean(selectedModel?.supportsFastMode)
  const showSpeed = Boolean(onSelectServiceTier && (supportsFastMode || serviceTier !== 'inherit'))
  const showFast =
    showSpeed && (serviceTier === 'fast' || (serviceTier === 'inherit' && selectedModel?.defaultServiceTier === 'fast'))
  const speedLabel = nextMessageSpeed ? '下一条消息的 Fast 模式' : 'Fast 模式'
  const activeLevels: readonly SessionThinkingLevel[] = allowUltra
    ? modelSessionThinkingLevels(selectedModel)
    : modelThinkingLevels(selectedModel)
  const currentIndex = activeLevels.indexOf(
    allowUltra
      ? resolveSessionThinkingLevel(selectedModel, thinkingLevel)
      : resolveModelThinkingLevel(selectedModel, thinkingLevel),
  )

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
  const isMax = activeLevel === 'max'
  const isUltra = activeLevel === 'ultra'
  const showParticles = activeLevels.length > 1 && (showFast || isUltra)
  // 用离散档位比例估算轨道距离，避免拖拽期间每帧改写 animationDuration 引起抖动
  const activeStepRatio = activeLevels.length > 1 ? activeIndex / (activeLevels.length - 1) : 0.5
  const flowParticles = React.useMemo(() => {
    if (!showParticles) return []
    const profile = isUltra && !showFast ? ULTRA_BASE_PARTICLE_PROFILE : FAST_PARTICLE_PROFILES[activeLevel]
    const travelDistancePx = Math.max(24, activeStepRatio * 200)
    return FLOW_PARTICLES.slice(0, profile.count).map(([top, baseSize, phase, speedScale, driftY, opacity]) => {
      const duration = Number((travelDistancePx / (profile.speedPxPerSec * speedScale)).toFixed(2))
      const delay = Number((-phase * duration).toFixed(2))
      const size = Number((baseSize * profile.sizeScale).toFixed(2))
      const staticX = Math.round(10 + (1 - phase) * 76)
      return {
        top,
        size,
        duration,
        delay,
        driftY,
        opacity,
        glowBlur: profile.glowBlur,
        staticX,
      }
    })
  }, [showParticles, isUltra, showFast, activeLevel, activeStepRatio])

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
    onSelectThinkingLevel(resolveModelThinkingLevel(selectedModel, 'medium'))
  }

  // 快速模式二态开关（开 / 不开）
  const handleToggleFastMode = () => {
    if (disabled || busy || !onSelectServiceTier) return
    if (!supportsFastMode) {
      onSelectServiceTier('inherit')
      return
    }
    if (showFast) {
      onSelectServiceTier(selectedModel?.defaultServiceTier === 'fast' ? 'standard' : 'inherit')
    } else {
      onSelectServiceTier('fast')
    }
  }

  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const closedByOutsidePointer = React.useRef(false)
  React.useEffect(() => {
    if (!active || !open) return
    const ownerDocument = triggerRef.current?.ownerDocument
    if (!ownerDocument) return
    const dismissOutside = (event: PointerEvent) => {
      const path = event.composedPath()
      if (path.includes(triggerRef.current!) || path.includes(contentRef.current!)) return
      closedByOutsidePointer.current = true
      gestureRef.current = null
      setDragRatio(null)
      setOpen(false)
    }
    ownerDocument.addEventListener('pointerdown', dismissOutside, true)
    return () => ownerDocument.removeEventListener('pointerdown', dismissOutside, true)
  }, [active, open])

  // 挂载时以当前版本为基线，避免重新挂载时重放历史打开请求。
  const handledOpenModelsVersion = React.useRef(openModelsVersion)
  React.useEffect(() => {
    const requested = openModelsVersion !== handledOpenModelsVersion.current
    handledOpenModelsVersion.current = openModelsVersion
    if (!active) {
      gestureRef.current = null
      setDragRatio(null)
      setOpen(false)
      return
    }
    if (requested && openModelsVersion && openModelsVersion > 0 && !disabled && !busy) {
      closedByOutsidePointer.current = false
      setView('models')
      setQuery('')
      setShowSearch(false)
      setOpen(true)
    }
  }, [active, openModelsVersion, disabled, busy])

  // 切页时连同 Portal 立即卸载，避免退场动画继续跟随已经隐藏的触发器定位。
  if (!active) return null

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        gestureRef.current = null
        setDragRatio(null)
        if (nextOpen) {
          closedByOutsidePointer.current = false
          setQuery('')
          setShowSearch(false)
          setView(mobile && activeLevels.length <= 1 ? 'models' : 'thinking')
        }
        setOpen(nextOpen)
      }}
    >
      <TooltipHint
        content={`${displayName} · ${currentLevelLabel}${showFast ? ' · Fast' : ''}${shortcutLabel ? `（${shortcutLabel}）` : ''}`}
        open={open ? false : undefined}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-busy={busy || undefined}
            aria-label={
              showSpeed ? `选择模型、思考强度与 Fast 模式${showFast ? '，已开启' : ''}` : '选择模型与思考强度'
            }
            data-thinking-level={activeLevel}
            className={cn(
              'model-thinking-theme inline-flex min-w-0 max-w-full whitespace-nowrap items-center justify-center select-none cursor-pointer transition-colors rounded-full',
              'bg-secondary/60 hover:bg-secondary text-foreground/90 hover:text-foreground',
              mobile
                ? 'h-9 w-auto gap-1.5 px-3 text-xs font-normal active:bg-secondary'
                : 'size-7 p-0 @min-[500px]:h-7 @min-[500px]:w-auto @min-[500px]:px-2.5 @min-[500px]:text-xs @min-[500px]:font-normal @min-[500px]:gap-1.5',
              disabled && 'cursor-not-allowed opacity-60',
              open && 'bg-secondary text-foreground',
            )}
          >
            {/* 窄视口或窄容器：仅显示大脑图标（桌面窄分栏）；移动端底栏已精简，直接展示模型名与思考强度 */}
            {!mobile && <Brain className="model-thinking-accent size-4 shrink-0 @min-[500px]:hidden" />}

            {/* 宽容器或移动端：稳定显示模型名称、思考强度与下拉箭头，结构稳定不突变 */}
            <div
              className={cn('min-w-0 items-center gap-1.5', mobile ? 'inline-flex' : 'hidden @min-[500px]:inline-flex')}
            >
              <div className={cn('flex min-w-0 items-center gap-1', mobile ? 'max-w-[165px]' : 'max-w-[160px]')}>
                <span className="min-w-0 truncate">{displayName}</span>
                {activeLevels.length > 1 && (
                  <span className="model-thinking-accent min-w-[2em] text-center font-medium shrink-0 text-[0.6875rem]">
                    {currentLevelLabel}
                  </span>
                )}
                {showFast && <span className="shrink-0 text-[0.6875rem] font-medium">Fast</span>}
              </div>
              <ChevronDown className="size-3 text-muted-foreground/80 shrink-0 ml-0.5" />
            </div>
          </button>
        </PopoverTrigger>
      </TooltipHint>

      <PopoverContent
        ref={contentRef}
        onCloseAutoFocus={(event) => {
          if (closedByOutsidePointer.current || !triggerRef.current?.isConnected) event.preventDefault()
        }}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        avoidCollisions={true}
        className={cn(
          'flex max-h-[min(24rem,calc(100dvh-100px))] max-w-[calc(100vw-24px)] flex-col rounded-2xl border-border/80 bg-popover p-3 shadow-xl select-none',
          mobile ? 'w-[min(calc(100vw-24px),340px)]' : 'w-64',
        )}
      >
        {view === 'thinking' ? (
          /* 图 1：思考强度配置面板 */
          <div
            className="model-thinking-panel model-thinking-theme flex flex-col gap-3 select-none"
            data-thinking-level={activeLevel}
            data-fast-mode={showFast ? 'on' : 'off'}
          >
            {/* 顶栏：左侧 Fast 开关，中间高亮强度文字与模型入口，右侧重置按钮 */}
            <div className="flex items-start justify-between px-1">
              <div className="flex size-6 shrink-0 items-center justify-center">
                {showSpeed ? (
                  <TooltipHint
                    side="top"
                    content={
                      supportsFastMode ? (
                        <span className="flex flex-col">
                          <span>
                            {nextMessageSpeed
                              ? `下一条消息 Fast：${showFast ? '已开启' : '已关闭'}`
                              : `Fast 模式：${showFast ? '已开启' : '已关闭'}`}
                          </span>
                          <span className="text-muted-foreground">优先处理，可能增加用量</span>
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          <span>当前模型不支持 Fast</span>
                          <span className="text-muted-foreground">点击关闭并恢复默认</span>
                        </span>
                      )
                    }
                  >
                    <span className="inline-flex shrink-0" tabIndex={disabled || busy ? 0 : undefined}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={showFast}
                        disabled={disabled || busy}
                        onClick={handleToggleFastMode}
                        data-fast-active={showFast ? 'true' : 'false'}
                        aria-label={
                          supportsFastMode
                            ? `${speedLabel}：${showFast ? '已开启' : '已关闭'}`
                            : '当前模型不支持 Fast，点击关闭'
                        }
                        className={cn(
                          'model-thinking-fast-toggle flex size-6 items-center justify-center rounded-md transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                          showFast
                            ? 'hover:bg-secondary/60'
                            : 'text-muted-foreground/75 hover:bg-secondary/60 hover:text-foreground',
                        )}
                      >
                        <Zap aria-hidden className={cn('size-4', showFast && 'fill-current')} strokeWidth={1.75} />
                      </button>
                    </span>
                  </TooltipHint>
                ) : isUltra ? (
                  <Zap aria-hidden className="model-thinking-accent size-3.5" />
                ) : null}
              </div>
              <div className="flex flex-col items-center">
                <TooltipHint content={isUltra ? ULTRA_DESCRIPTION : isMax ? 'Max · 模型原生最大思考强度' : undefined}>
                  <span className="model-thinking-accent model-thinking-title text-sm font-semibold tracking-wide leading-tight">
                    {currentLevelLabel}
                  </span>
                </TooltipHint>
                <button
                  type="button"
                  onClick={() => setView('models')}
                  aria-label="切换模型"
                  className={cn(
                    'group mt-1 inline-flex items-center gap-0.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md',
                    mobile && 'px-2 py-1 active:bg-secondary/60',
                  )}
                >
                  <span className={cn('truncate', mobile ? 'max-w-[200px]' : 'max-w-[160px]')}>{displayName}</span>
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground/70 group-hover:text-foreground transition-colors" />
                </button>
              </div>
              <TooltipHint content="重置为默认强度">
                <span className="inline-flex shrink-0" tabIndex={disabled || busy ? 0 : undefined}>
                  <button
                    type="button"
                    onClick={handleResetLevel}
                    disabled={disabled || busy}
                    aria-label="重置思考强度"
                    className="flex size-6 items-center justify-center text-muted-foreground/70 hover:text-foreground transition-colors rounded-md hover:bg-secondary/60 cursor-pointer"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                </span>
              </TooltipHint>
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
                aria-description={isUltra ? ULTRA_DESCRIPTION : undefined}
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
                className={cn(
                  'relative flex items-center w-full cursor-pointer touch-none select-none outline-none focus-visible:ring-2 rounded-full',
                  mobile ? 'py-2.5' : 'py-1.5',
                )}
              >
                {/* 轨道层：高 24px，圆球两侧各留 12px。 */}
                <div className="relative h-6 w-full rounded-full bg-foreground/10 flex items-center">
                  {/* 填充条和圆球共用右边界，只对填充宽度做动画。 */}
                  <div
                    className={cn(
                      'absolute left-0 top-0 bottom-0 rounded-l-full',
                      activeLevels.length > 1 && 'model-thinking-track-fill',
                      isDragging
                        ? 'transition-none'
                        : 'transition-[width] duration-150 ease-out motion-reduce:transition-none',
                    )}
                    style={{
                      width: `calc(12px + ${activeRatio} * (100% - 24px))`,
                    }}
                  >
                    {isMax && <span aria-hidden="true" className="model-thinking-fill model-thinking-max-fill" />}
                    {isUltra && <span aria-hidden="true" className="model-thinking-fill model-thinking-ultra-fill" />}
                    {showParticles && (
                      <span aria-hidden="true" className="model-thinking-particle-layer">
                        {flowParticles.map((particle, index) => (
                          <span
                            key={index}
                            className="model-thinking-particle-lane"
                            style={
                              {
                                '--particle-duration': `${particle.duration}s`,
                                '--particle-delay': `${particle.delay}s`,
                              } as React.CSSProperties
                            }
                          >
                            <span
                              className="model-thinking-particle"
                              style={
                                {
                                  top: `${particle.top}%`,
                                  width: `${particle.size}px`,
                                  height: `${particle.size}px`,
                                  '--particle-duration': `${particle.duration}s`,
                                  '--particle-delay': `${particle.delay}s`,
                                  '--particle-drift-y': `${particle.driftY}px`,
                                  '--particle-opacity': particle.opacity,
                                  '--particle-glow-blur': `${particle.glowBlur}px`,
                                  '--particle-static-x': `${particle.staticX}%`,
                                } as React.CSSProperties
                              }
                            />
                          </span>
                        ))}
                      </span>
                    )}
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
                          isPassed && showParticles ? 'opacity-0' : isPassed ? 'bg-white/80' : 'bg-foreground/25',
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
                  className={cn(
                    'rounded-md bg-secondary/30 pr-7 pl-7 focus-visible:ring-1 focus-visible:ring-ring',
                    mobile ? 'h-9 text-base' : 'h-7 text-xs',
                  )}
                  autoFocus={!mobile}
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
                          'flex w-full items-center justify-between rounded-xl px-2.5 text-left text-sm transition-colors cursor-pointer',
                          mobile ? 'min-h-[44px] py-2.5' : 'py-2',
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
