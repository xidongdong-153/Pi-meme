import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { ChevronDown } from 'lucide-react'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import {
  contextPartKinds,
  type ContextPartKind,
  type ContextPromptItem,
  type ContextRequest,
  type ContextWindowApi,
} from '@pi-meme/contracts/context-window'
import { cellsOf, fmtK, headroom, health, itemName, partNames, pct, tilesOf } from './layout'
import { Dialog, DialogContent, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'
import { ModelIcon } from './model-icon'
import './context-window.css'

const ContextTextDialog = lazy(() => import('./context-text-dialog'))
export type ContextWindowPanelProps = {
  api: ContextWindowApi
  session: SessionRef
  visible: boolean
  reducedMotion?: boolean
  sessionName?: string
  onChange?: (listener: () => void) => () => void
}
type TextPick = { request: ContextRequest; kind: ContextPartKind; item?: ContextPromptItem }
type Focus = { kind: ContextPartKind | 'free'; itemId?: string }
type Point = { id: string; tokens: number; time: string }
const partNotes: Record<ContextPartKind, string> = {
  system: 'agent 自带的指令',
  tools: '它可调用的工具的定义',
  skills: '它可加载的技能：每个的名字和用途',
  memory: '指令文件、记忆和提醒',
  files: '它读取的文件和图片',
  results: '它调用的其他工具返回的内容',
  chat: '你和模型的对话，逐轮',
}
function LookIcon({ mode }: { mode: 'map' | 'grid' }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {mode === 'map' ? (
        <>
          <rect x="1.5" y="2" width="5.5" height="12" rx="1.6" />
          <rect x="8.5" y="2" width="6" height="6.5" rx="1.6" />
          <rect x="8.5" y="10" width="6" height="4" rx="1.4" />
        </>
      ) : (
        [2, 6.5, 11].flatMap((y) =>
          [2, 6.5, 11].map((x) => <rect key={`${x}:${y}`} x={x} y={y} width="3" height="3" rx=".8" />),
        )
      )}
    </svg>
  )
}
function readPreference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Memory state remains available. */
  }
}
function useMeasure(ref: RefObject<HTMLDivElement | null>, initial: { width: number; height: number }) {
  const [size, setSize] = useState(initial)
  useEffect(() => {
    if (!ref.current) return
    let frame = 0
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect?.width || !rect.height) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setSize((previous) =>
          previous.width === rect.width && previous.height === rect.height
            ? previous
            : { width: rect.width, height: rect.height },
        ),
      )
    })
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [ref])
  return size
}
function Count({ value, quiet }: { value: number; quiet: boolean }) {
  const node = useRef<HTMLSpanElement>(null)
  const previous = useRef(value)
  useEffect(() => {
    const element = node.current
    if (!element) return
    let frame = 0
    const from = previous.current
    previous.current = value
    if (quiet || from === value) {
      element.textContent = fmtK(value)
      return
    }
    const start = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - start) / 620))
      const number = from + (value - from) * (1 - (1 - k) ** 4)
      element.textContent = fmtK(number)
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value, quiet])
  return <span ref={node}>{fmtK(value)}</span>
}
function Label({ item, kind }: { item: ContextPromptItem; kind: ContextPartKind }) {
  const name = itemName(item)
  const at = kind === 'files' || kind === 'memory' ? name.lastIndexOf('/') : -1
  return (
    <span className="ctx-name" title={name}>
      <b>{at >= 0 ? name.slice(at + 1) : name}</b>
      {at >= 0 ? <small>{name.slice(0, at + 1)}</small> : null}
    </span>
  )
}
function Spark({
  series,
  at,
  window,
  onPoint,
}: {
  series: Point[]
  at: string
  window: number
  onPoint: (id: string) => void
}) {
  const W = 240
  const H = 34
  const pad = 3
  const peak = Math.max(...series.map((p) => p.tokens), 1)
  const top = window && peak > window * 0.6 ? Math.max(window, peak) : peak * 1.2
  const x = (i: number) => (series.length < 2 ? W / 2 : pad + (i / (series.length - 1)) * (W - pad * 2))
  const y = (n: number) => H - pad - (n / top) * (H - pad * 2)
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`)
  const selected = series.findIndex((p) => p.id === at)
  return (
    <span className="ctx-spark">
      <svg viewBox="0 0 240 34" preserveAspectRatio="none" aria-label="本会话的请求上下文变化">
        {window > 0 && window <= top ? <line x1="0" x2={W} y1={y(window)} y2={y(window)} className="win" /> : null}
        {series.length > 1 ? (
          <>
            <path
              d={`M${pts[0]} L${pts.slice(1).join(' L')} L${x(series.length - 1)},${H} L${x(0)},${H} Z`}
              className="area"
            />
            <polyline points={pts.join(' ')} className="line" />
          </>
        ) : null}
        {series.map((point, i) => {
          const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2
          const right = i === series.length - 1 ? W : (x(i) + x(i + 1)) / 2
          return (
            <rect
              key={point.id}
              x={left}
              y={0}
              width={right - left}
              height={H}
              className={`hit${point.id === at ? ' on' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={`请求 ${i + 1}：${fmtK(point.tokens)} token`}
              aria-pressed={point.id === at}
              onClick={() => onPoint(point.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onPoint(point.id)
                }
              }}
            >
              <title>{`请求 ${i + 1}：${fmtK(point.tokens)} token`}</title>
            </rect>
          )
        })}
      </svg>
      {selected >= 0 ? (
        <span
          className="at"
          style={{ left: `${(x(selected) / W) * 100}%`, top: `${(y(series[selected].tokens) / H) * 100}%` }}
        />
      ) : null}
    </span>
  )
}
const Card = memo(
  ({
    request,
    series,
    sessionName,
    quiet,
    onOpen,
    onPoint,
    pinned,
    onLive,
  }: {
    request: ContextRequest
    series: Point[]
    sessionName?: string
    quiet: boolean
    onOpen: (pick: TextPick) => void
    onPoint: (id: string) => void
    pinned: boolean
    onLive: () => void
  }) => {
    const p = request.prompt!
    const windowSize = p.window ?? 0
    const fill = windowSize ? p.tokens / windowSize : 0
    const [tone, healthName] = health(fill)
    const [fold, setFold] = useState(() => readPreference('pi-meme:context:fold') === '1')
    const [look, setLook] = useState(() => (readPreference('pi-meme:context:look') === 'grid' ? 'grid' : 'map'))
    const [tab, setTab] = useState<ContextPartKind | 'all'>('all')
    const [more, setMore] = useState(false)
    const [focus, setFocus] = useState<Focus>()
    const [tip, setTip] = useState<{
      title: string
      sub: string
      rows: ContextPromptItem[]
      target: HTMLElement
      kind: ContextPartKind | 'free'
    }>()
    const [gridAt, setGridAt] = useState(0)
    const tipNode = useRef<HTMLDivElement>(null)
    const card = useRef<HTMLDivElement>(null)
    const map = useRef<HTMLDivElement>(null)
    const grid = useRef<HTMLDivElement>(null)
    const cardSize = useMeasure(card, { width: 480, height: 500 })
    const mapSize = useMeasure(map, { width: 440, height: 220 })
    const cells = useMemo(() => cellsOf(p, windowSize), [p, windowSize])
    const tiles = useMemo(
      () => tilesOf(p, windowSize, mapSize.width, mapSize.height),
      [p, windowSize, mapSize.width, mapSize.height],
    )
    const rows = useMemo(
      () =>
        p.parts
          .flatMap((part) => part.items.map((item) => ({ kind: part.kind, item })))
          .filter(
            (row) => tab === 'all' || !p.parts.some((part) => part.kind === tab && part.tokens > 0) || row.kind === tab,
          )
          .sort((a, b) => b.item.tokens - a.item.tokens),
      [p, tab],
    )
    const activeTab = tab !== 'all' && !p.parts.some((part) => part.kind === tab && part.tokens > 0) ? 'all' : tab
    const availableParts = contextPartKinds.filter((kind) =>
      p.parts.some((part) => part.kind === kind && part.tokens > 0),
    )
    useLayoutEffect(() => {
      const node = tipNode.current
      const host = card.current
      if (!tip || !node || !host || fold) return
      const target = tip.target
      let frame = 0
      const place = () => {
        if (!target.isConnected || !target.getClientRects().length) {
          node.style.visibility = 'hidden'
          return
        }
        const bounds = host.getBoundingClientRect()
        const anchor = target.getBoundingClientRect()
        const width = node.offsetWidth
        const height = node.offsetHeight
        const left = Math.max(
          8,
          Math.min(bounds.width - width - 8, anchor.left - bounds.left + anchor.width / 2 - width / 2),
        )
        let top = anchor.top - bounds.top - height - 8
        if (top < 4) top = anchor.bottom - bounds.top + 8
        node.style.left = `${left}px`
        node.style.top = `${top}px`
        node.style.visibility = 'visible'
      }
      place()
      // Match Magpie's followTip while the map's tiles glide to their new coordinates.
      const started = performance.now()
      const follow = (now: number) => {
        place()
        if (now - started < 660) frame = requestAnimationFrame(follow)
      }
      frame = requestAnimationFrame(follow)
      const observer = new ResizeObserver(place)
      for (const element of [node, host, target]) observer.observe(element)
      return () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
      }
    }, [tip, tiles, fold])
    const showTip = (
      target: HTMLElement,
      title: string,
      sub: string,
      items: ContextPromptItem[],
      kind: ContextPartKind | 'free',
      itemId?: string,
    ) => {
      setFocus({ kind, itemId })
      setTip({ title, sub, rows: items.slice(0, 5), kind, target })
    }
    const clear = () => {
      setFocus(undefined)
      setTip(undefined)
    }
    const open = (kind: ContextPartKind, item?: ContextPromptItem) => {
      clear()
      onOpen({ request, kind, item })
    }
    const isOn = (kind: ContextPartKind | '', items: ContextPromptItem[]) =>
      !!focus && focus.kind === kind && (!focus.itemId || items.some((item) => item.id === focus.itemId))
    const tagName = (tag?: string) => (tag && !['turn', 'turns', 'more', 'compacted'].includes(tag) ? tag : '')
    const cacheRef = useRef<{ session: string; read: number; total: number } | undefined>(undefined)
    const cacheSession = request.nativeSessionId
    const cache =
      request.cacheKnowledge === 'known' && request.prompt?.counted && request.usage
        ? {
            read: request.usage.cacheRead,
            total: request.usage.input + request.usage.cacheRead + request.usage.cacheWrite,
          }
        : undefined
    useEffect(() => {
      if (cache && cache.total > 0) cacheRef.current = { session: cacheSession, ...cache }
    }, [cache?.read, cache?.total, cacheSession])
    const shownCache =
      cache && cache.total > 0
        ? cache
        : !request.done && cacheRef.current?.session === cacheSession
          ? cacheRef.current
          : undefined
    const cacheSeen = !!shownCache || cacheRef.current?.session === cacheSession
    const turns = headroom(series, Math.max(0, windowSize - p.tokens))
    const state = !request.done ? 'live' : p.counted ? 'counted' : 'est'
    return (
      <div
        ref={card}
        className={`ctx-card${fold ? ' shut' : ''}${cardSize.width <= 520 ? ' max520' : ''}${cardSize.width <= 420 ? ' max420' : ''}`}
      >
        <div className="ctx-head">
          <button
            className="ctx-fold"
            aria-expanded={!fold}
            onClick={() => {
              setFold(!fold)
              savePreference('pi-meme:context:fold', !fold ? '1' : '0')
              clear()
            }}
          >
            <span className="tw">
              <ChevronDown size={10} />
            </span>
            <span className="ctx-title">上下文窗口</span>
          </button>
          <span className="ctx-short">
            {fmtK(p.tokens)}
            {windowSize ? ` / ${fmtK(windowSize)} · ${pct(fill)}` : ''}
          </span>
          <span className="ctx-stack">
            {contextPartKinds.map((kind) => (
              <i
                key={kind}
                className={`k-${kind}`}
                style={{
                  width: `${((p.parts.find((part) => part.kind === kind)?.tokens ?? 0) / Math.max(windowSize, p.tokens, 1)) * 100}%`,
                }}
              />
            ))}
          </span>
          <span className="grow" />
          <span className="ctx-end">
            <span className="ctx-route">
              <span className="ctx-who">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z"
                  />
                  <path d="M17.5 12H23v11h-5.5V12z" />
                </svg>
                <span className="ctx-who-n">Pi meme</span>
              </span>
              <span className="ctx-sep">›</span>
              <span className="ctx-what">
                <ModelIcon model={request.servedModel ?? request.model} />
                <code className="ctx-model" title={request.servedModel ?? request.model}>
                  {request.servedModel ?? request.model}
                </code>
              </span>
            </span>
            <span
              className={`ctx-state ${state}`}
              title={
                !request.done
                  ? '请求正在进行，按 agent 发送的内容估算。'
                  : p.counted
                    ? '总量以服务商计量为准；分项根据请求内容估算后按总量缩放。'
                    : '服务商没有告知输入用量，按发送的内容估算。'
              }
            >
              <i />
              <span className="ctx-state-w">
                {[
                  ['live', '实时'],
                  ['counted', '已计数'],
                  ['est', '估算'],
                ].map(([key, text]) => (
                  <span key={key} className={state === key ? 'on' : ''} aria-hidden={state !== key}>
                    {text}
                  </span>
                ))}
              </span>
            </span>
          </span>
        </div>
        <RevealContent ready={!fold} className="ctx-body">
          <div className="ctx-top">
            <div className="ctx-stat">
              <div className="ctx-k">
                已用上下文{windowSize ? <span className={`ctx-health ${tone}`}>{healthName}</span> : null}
              </div>
              <div className="ctx-big">
                <b>
                  <Count value={p.tokens} quiet={quiet} />
                </b>
                <span>{windowSize ? `/ ${fmtK(windowSize)} token` : 'token'}</span>
              </div>
              <div className="ctx-sub">
                {windowSize
                  ? `已用 ${pct(fill)} · ${turns !== null ? (turns >= 999 ? '余量充足' : `约还能容纳 ${turns} 个请求`) : `剩余 ${fmtK(Math.max(0, windowSize - p.tokens))}`}`
                  : '模型的窗口大小未知'}
              </div>
            </div>
            {cacheSeen || request.done ? (
              <div className={`ctx-stat ctx-cache${shownCache && !cache ? ' was' : !shownCache ? ' none' : ''}`}>
                <div className="ctx-k">提示词缓存</div>
                <div className="ctx-big">
                  <b>{shownCache ? pct(shownCache.read / shownCache.total) : '—'}</b>
                  <span>命中</span>
                </div>
                <div className="ctx-bar">
                  <i style={{ width: `${shownCache ? (shownCache.read / shownCache.total) * 100 : 0}%` }} />
                </div>
                <div className="ctx-sub">
                  {cache
                    ? `${fmtK(cache.read)} 来自缓存 · ${fmtK(cache.total - cache.read)} 新增`
                    : shownCache
                      ? '上一个请求的 · 本次请求进行中'
                      : request.done
                        ? '供应商未报告'
                        : '供应商回答后可见'}
                </div>
              </div>
            ) : null}
          </div>
          <div className="ctx-viz" data-look={look}>
            <div
              ref={map}
              className="ctx-map"
              data-f={focus ? (focus.itemId ? 'tile' : focus.kind) : undefined}
              role="group"
              aria-label={`已用 ${fmtK(p.tokens)} / ${fmtK(windowSize || p.tokens)} token`}
              onPointerLeave={clear}
            >
              {tiles.map((tile, tileIndex) => {
                const title = tile.free
                  ? '剩余空间'
                  : tile.it
                    ? itemName(tile.it) +
                      ((tile.it.n ?? 0) > 1 && !['turns', 'more'].includes(tile.it.tag ?? '') ? ` ×${tile.it.n}` : '')
                    : tile.key === tile.kind
                      ? partNames[tile.kind as ContextPartKind]
                      : `另外 ${tile.its.length} 项`
                const dirs = new Set(tile.its.map((item) => item.name.slice(0, item.name.lastIndexOf('/') + 1)))
                const dir = [...dirs][0]
                const groupedDirectory =
                  !tile.it && tile.kind === 'files' && tile.key !== tile.kind && dirs.size === 1 && !!dir
                const shortTitle = groupedDirectory
                  ? dir.slice(dir.lastIndexOf('/', dir.length - 2) + 1)
                  : tile.it && ['files', 'memory'].includes(tile.kind)
                    ? title.slice(title.lastIndexOf('/') + 1) || title
                    : title
                const sub = groupedDirectory
                  ? `${fmtK(tile.tokens)} · ${tile.its.length} 个文件`
                  : tile.free
                    ? `${fmtK(tile.tokens)} · ${pct(tile.tokens / Math.max(windowSize, p.tokens, 1))}`
                    : `${fmtK(tile.tokens)}${tile.it ? ` · ${partNames[tile.kind as ContextPartKind]}` : ''}`
                const style: CSSProperties = {
                  animationDelay: quiet ? '0ms' : `${40 + Math.min(tileIndex, 16) * 32}ms`,
                  left: `calc(${(tile.x / mapSize.width) * 100}% + 1.5px)`,
                  top: `calc(${(tile.y / mapSize.height) * 100}% + 1.5px)`,
                  width: `max(0px, calc(${(tile.w / mapSize.width) * 100}% - 3px))`,
                  height: `max(0px, calc(${(tile.h / mapSize.height) * 100}% - 3px))`,
                }
                return (
                  <button
                    key={tile.key}
                    className={`ctx-tile ${tile.free ? 'free' : `k-${tile.kind}`}${tile.w < 54 || tile.h < 30 ? ' bare' : tile.h < 46 ? ' low' : ''}${isOn(tile.kind, tile.its) ? ' on' : ''}`}
                    style={style}
                    aria-label={`${title}，${sub}`}
                    tabIndex={tile.free ? -1 : 0}
                    aria-disabled={tile.free || undefined}
                    onPointerEnter={(event) =>
                      showTip(
                        event.currentTarget,
                        title,
                        sub,
                        tile.its,
                        tile.free ? 'free' : (tile.kind as ContextPartKind),
                        tile.it?.id,
                      )
                    }
                    onFocus={(event) =>
                      showTip(
                        event.currentTarget,
                        title,
                        sub,
                        tile.its,
                        tile.free ? 'free' : (tile.kind as ContextPartKind),
                        tile.it?.id,
                      )
                    }
                    onBlur={clear}
                    onClick={() => {
                      if (!tile.free) open(tile.kind as ContextPartKind, tile.it)
                    }}
                  >
                    <b className="n">{shortTitle}</b>
                    <span className="v">{sub}</span>
                  </button>
                )
              })}
            </div>
            <div
              ref={grid}
              className="ctx-waffle"
              data-f={focus ? (focus.itemId ? 'item' : focus.kind) : undefined}
              role="group"
              aria-label="上下文窗口，400 个方格"
              onPointerLeave={clear}
            >
              {cells.map((cell, index) => (
                <button
                  key={index}
                  className={`${cell ? `k-${cell.kind}` : 'free'}${cell && isOn(cell.kind, cell.item ? [cell.item] : []) ? ' on' : ''}`}
                  tabIndex={index === gridAt ? 0 : -1}
                  style={{ '--d': `${Math.round(index * 1.4)}ms` } as CSSProperties}
                  aria-label={
                    cell
                      ? `${partNames[cell.kind]}：${cell.item ? itemName(cell.item) : fmtK(p.parts.find((part) => part.kind === cell.kind)?.tokens ?? 0)}`
                      : '剩余空间'
                  }
                  onKeyDown={(event) => {
                    const columns = cardSize.width <= 520 ? 25 : 50
                    const change: Record<string, number> = {
                      ArrowRight: 1,
                      ArrowLeft: -1,
                      ArrowUp: -columns,
                      ArrowDown: columns,
                    }
                    if (change[event.key] !== undefined) {
                      event.preventDefault()
                      const next = Math.max(0, Math.min(399, index + change[event.key]))
                      setGridAt(next)
                      ;(grid.current?.children[next] as HTMLElement | undefined)?.focus()
                    }
                  }}
                  onFocus={(event) => {
                    setGridAt(index)
                    const part = cell ? p.parts.find((part) => part.kind === cell.kind) : undefined
                    showTip(
                      event.currentTarget,
                      cell ? partNames[cell.kind] : '剩余空间',
                      cell
                        ? `${fmtK(part?.tokens ?? 0)} · ${pct((part?.tokens ?? 0) / Math.max(1, p.tokens))}`
                        : fmtK(Math.max(0, windowSize - p.tokens)),
                      part?.items ?? [],
                      cell?.kind ?? 'free',
                      cell?.item?.id,
                    )
                  }}
                  onBlur={clear}
                  onPointerEnter={(event) => {
                    const part = cell ? p.parts.find((part) => part.kind === cell.kind) : undefined
                    showTip(
                      event.currentTarget,
                      cell ? partNames[cell.kind] : '剩余空间',
                      fmtK(part?.tokens ?? Math.max(0, windowSize - p.tokens)),
                      part?.items ?? [],
                      cell?.kind ?? 'free',
                      cell?.item?.id,
                    )
                  }}
                  onClick={() => {
                    if (cell) open(cell.kind, cell.item)
                  }}
                />
              ))}
            </div>
          </div>
          <div className="ctx-legend">
            {availableParts.map((kind) => (
              <button
                key={kind}
                className="ctx-leg ctx-click"
                title={partNotes[kind]}
                onClick={() => open(kind)}
                onPointerEnter={() => setFocus({ kind })}
                onPointerLeave={clear}
                onFocus={() => setFocus({ kind })}
                onBlur={clear}
              >
                <i className={`dot k-${kind}`} />
                <span className="n">{partNames[kind]}</span>
                <span className="v">
                  <Count value={p.parts.find((part) => part.kind === kind)?.tokens ?? 0} quiet={quiet} />
                </span>
              </button>
            ))}
            {windowSize > p.tokens ? (
              <span className="ctx-leg" onPointerEnter={() => setFocus({ kind: 'free' })} onPointerLeave={clear}>
                <i className="dot free" />
                <span className="n">剩余空间</span>
                <span className="v">{fmtK(windowSize - p.tokens)}</span>
              </span>
            ) : null}
            <span className="ctx-look" role="group" aria-label="上下文显示方式">
              {(['map', 'grid'] as const).map((mode) => (
                <button
                  key={mode}
                  className={`ctx-look-b${look === mode ? ' on' : ''}`}
                  aria-label={mode === 'map' ? '上下文地图' : '方格'}
                  aria-pressed={look === mode}
                  title={mode === 'map' ? '上下文地图' : '方格'}
                  onClick={() => {
                    setLook(mode)
                    savePreference('pi-meme:context:look', mode)
                    clear()
                  }}
                >
                  <LookIcon mode={mode} />
                </button>
              ))}
            </span>
          </div>
          <div className="ctx-contents">
            <div className="ctx-contents-head">
              <span className="ctx-k">内容</span>
              <span className="grow" />
              <div className="segs" role="group" aria-label="内容分类">
                {(['all', ...availableParts] as const).map((kind) => (
                  <button
                    key={kind}
                    className={`opt${activeTab === kind ? ' on' : ''}`}
                    aria-pressed={activeTab === kind}
                    onClick={() => {
                      setTab(kind)
                      setMore(false)
                      clear()
                    }}
                  >
                    {kind === 'all' ? '全部' : partNames[kind]}
                  </button>
                ))}
              </div>
            </div>
            <div className="ctx-rows">
              {rows.slice(0, more ? rows.length : 8).map(({ item, kind }) => (
                <button
                  key={`${kind}:${item.id}`}
                  className="ctx-row"
                  onClick={() => open(kind, item)}
                  onPointerEnter={() => setFocus({ kind, itemId: item.id })}
                  onPointerLeave={clear}
                  onFocus={() => setFocus({ kind, itemId: item.id })}
                  onBlur={clear}
                >
                  <i className={`dot k-${kind}`} />
                  <Label {...{ item, kind }} />
                  {(item.n ?? 0) > 1 && !['turns', 'more'].includes(item.tag ?? '') ? (
                    <span className="ctx-x">×{item.n}</span>
                  ) : null}
                  {tagName(item.tag) ? <code className="ctx-tag">{tagName(item.tag)}</code> : null}
                  <span className="ctx-mini">
                    <i
                      className={`k-${kind}`}
                      style={{
                        width: `${Math.max(2, (item.tokens / Math.max(1, ...rows.map((row) => row.item.tokens))) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="ctx-v">{fmtK(item.tokens)}</span>
                </button>
              ))}
              {!rows.length ? <div className="ctx-empty">没有内容</div> : null}
              {rows.length > 8 ? (
                <button className="text ctx-more" onClick={() => setMore(!more)}>
                  {more ? '收起' : `显示全部 ${rows.length} 项`}
                </button>
              ) : null}
            </div>
          </div>
          <div className="ctx-foot">
            <code className="ctx-crumbs" title={request.id}>
              Pi meme › {sessionName ?? request.nativeSessionId.slice(0, 12)} › #{request.sequence}
            </code>
            <span className="grow" />
            {p.held ? <span className="ctx-note">更早的轮次保存在服务商那里</span> : null}
            {p.turns ? <span className="ctx-note">{p.turns} 轮</span> : null}
          </div>
          {series.length > 1 ? (
            <div className="ctx-session">
              <span className="ctx-k">本会话</span>
              <Spark {...{ series, at: request.id, window: windowSize, onPoint }} />
              <span className="ctx-sub">{series.length} 个请求</span>
            </div>
          ) : null}
          {pinned ? (
            <button className="text ctx-follow" onClick={onLive}>
              返回实时
            </button>
          ) : null}
          {request.error ? (
            <p className="ctx-request-error" role="status">
              {request.error}
            </p>
          ) : null}
        </RevealContent>
        {tip && !fold ? (
          <div ref={tipNode} className="ctx-tip" role="tooltip" style={{ visibility: 'hidden' }}>
            <div className="ctx-tip-head">
              <i className={`dot ${tip.kind === 'free' ? 'free' : `k-${tip.kind}`}`} />
              <b>{tip.title}</b>
            </div>
            <div className="ctx-tip-sub">{tip.sub}</div>
            {tip.rows.map((item) => (
              <div className="ctx-tip-row" key={item.id}>
                <span className="n">{itemName(item)}</span>
                <span>{fmtK(item.tokens)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  },
)
function SessionPanel({
  api,
  session,
  visible,
  reducedMotion = false,
  sessionName,
  onChange,
}: ContextWindowPanelProps) {
  const [requests, setRequests] = useState<ContextRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pinned, setPinned] = useState<string>()
  const [detail, setDetail] = useState<ContextRequest>()
  const [pick, setPick] = useState<TextPick>()
  const [refresh, setRefresh] = useState(0)
  const [systemReduce, setSystemReduce] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setSystemReduce(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!visible) setPick(undefined)
  }, [visible])
  useEffect(() => {
    if (!pick) return
    const latest = requests.find((request) => request.id === pick.request.id)
    if (
      latest &&
      (latest.payloadRevision ?? Math.floor(latest.revision / 1_000_000)) !==
        (pick.request.payloadRevision ?? Math.floor(pick.request.revision / 1_000_000))
    )
      setPick(undefined)
  }, [pick, requests])
  useEffect(() => {
    if (!visible) return
    let current = true
    let busy = false
    let again = false
    const load = async () => {
      if (!current || document.hidden) return
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        const first = await api.list(session, { limit: 100 })
        if (!current) return
        const second = first.nextCursor ? await api.list(session, { cursor: first.nextCursor, limit: 60 }) : undefined
        if (!current) return
        const next = [
          ...new Map([...first.requests, ...(second?.requests ?? [])].map((request) => [request.id, request])).values(),
        ]
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, 160)
        setRequests((previous) =>
          previous.length === next.length &&
          previous.every((item, index) => item.id === next[index].id && item.revision === next[index].revision)
            ? previous
            : next,
        )
        setError('')
      } catch (cause) {
        if (current) setError(String(cause))
      } finally {
        busy = false
        if (current) {
          setLoading(false)
          if (again) {
            again = false
            void load()
          }
        }
      }
    }
    void load()
    const timer = setInterval(() => void load(), 1500)
    const off = onChange?.(() => void load())
    const resume = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      current = false
      clearInterval(timer)
      off?.()
      document.removeEventListener('visibilitychange', resume)
    }
  }, [api, session, visible, onChange, refresh])
  useEffect(() => {
    if (!pinned || !visible) return
    let current = true
    void api
      .get(session, pinned)
      .then((value) => {
        if (current) {
          setDetail(value)
          setError('')
        }
      })
      .catch((cause) => {
        if (current) setError(String(cause))
      })
    return () => {
      current = false
    }
  }, [api, session, pinned, visible, refresh])
  const selected = pinned
    ? (requests.find((request) => request.id === pinned) ?? (detail?.id === pinned ? detail : undefined))
    : (requests.find((request) => request.prompt) ?? requests[0])
  const unavailableLatest = !pinned && requests[0] && requests[0].id !== selected?.id ? requests[0] : undefined
  const series = useMemo(
    () =>
      [...requests]
        .reverse()
        .filter((request) => request.prompt)
        .slice(-160)
        .map((request) => ({ id: request.id, tokens: request.prompt!.tokens, time: request.time })),
    [requests],
  )
  const open = useCallback((value: TextPick) => setPick(value), [])
  const point = useCallback((id: string) => {
    setPinned(id)
    setPick(undefined)
  }, [])
  const live = useCallback(() => {
    setPinned(undefined)
    setDetail(undefined)
  }, [])
  return (
    <div
      className="magpie-context context-window-panel"
      data-reduced-motion={reducedMotion || systemReduce || undefined}
      data-hidden={!visible || undefined}
    >
      {error ? (
        <div className="ctx-panel-error" role="alert">
          {error}
          <button className="text" onClick={() => setRefresh(refresh + 1)}>
            重试
          </button>
        </div>
      ) : null}
      {unavailableLatest ? (
        <p className="ctx-panel-error" role="status">
          {unavailableLatest.phase === 'aborted'
            ? '最近请求已中断'
            : (unavailableLatest.error ?? '最近请求无法解析上下文')}
          ；显示最近可用快照。
        </p>
      ) : null}
      {selected?.prompt ? (
        <Card
          request={selected}
          {...{
            series,
            sessionName,
            onOpen: open,
            onPoint: point,
            pinned: !!pinned,
            onLive: live,
            quiet: reducedMotion || systemReduce || !visible,
          }}
        />
      ) : (
        <div className="ctx-card ctx-panel-state" aria-busy={loading}>
          <div className="ctx-title">上下文窗口</div>
          <p role="status">
            {loading
              ? '正在读取…'
              : selected
                ? (selected.error ??
                  (selected.bodyState === 'too-large'
                    ? '此请求超出正文保留上限，无法解析上下文。'
                    : '此请求暂不支持解析上下文。'))
                : pinned
                  ? '此请求的上下文不可用。'
                  : '此会话尚无上下文快照。'}
          </p>
          {pinned ? (
            <button className="text" onClick={live}>
              返回实时
            </button>
          ) : null}
        </div>
      )}
      {visible && pick ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPick(undefined)
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            className="magpie-context ctx-dialog"
            data-reduced-motion={reducedMotion || systemReduce || undefined}
          >
            <Suspense
              fallback={
                <>
                  <div className="ehead">
                    <DialogTitle>{partNames[pick.kind]}</DialogTitle>
                  </div>
                  <div className="ctx-view-scroll">
                    <p role="status" className="ctx-view-wait">
                      正在读取…
                    </p>
                  </div>
                  <div className="bar">
                    <span className="grow" />
                    <button className="text primary" onClick={() => setPick(undefined)}>
                      关闭
                    </button>
                  </div>
                </>
              }
            >
              <ContextTextDialog
                key={`${pick.request.id}:${pick.kind}:${pick.item?.id ?? ''}`}
                api={api}
                session={session}
                request={pick.request}
                kind={pick.kind}
                pick={pick.item}
                reducedMotion={reducedMotion || systemReduce}
                onClose={() => setPick(undefined)}
              />
            </Suspense>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
export const ContextWindowPanel = memo(
  (props: ContextWindowPanelProps) => {
    const session = useMemo(
      () => ({ hostId: props.session.hostId, sessionId: props.session.sessionId }),
      [props.session.hostId, props.session.sessionId],
    )
    return <SessionPanel key={`${session.hostId}:${session.sessionId}`} {...props} session={session} />
  },
  (previous, next) =>
    previous.api === next.api &&
    previous.session.hostId === next.session.hostId &&
    previous.session.sessionId === next.session.sessionId &&
    previous.visible === next.visible &&
    previous.reducedMotion === next.reducedMotion &&
    previous.sessionName === next.sessionName &&
    previous.onChange === next.onChange,
)
