// Layout algorithms adapted from Magpie, MIT © 2026 yetone.
import {
  contextPartKinds,
  type ContextPrompt,
  type ContextPromptItem,
  type ContextPartKind,
  type ContextPromptPart,
} from '@pi-meme/contracts/context-window'

export const partNames: Record<ContextPartKind, string> = {
  system: '系统提示词',
  tools: '工具',
  skills: '技能',
  memory: '记忆',
  files: '文件',
  results: '工具结果',
  chat: '会话内容',
}
const names: Record<string, string> = {
  prompt: 'agent 提示词',
  harness: 'harness 消息',
  billing: '计费头',
  environment: '环境信息',
  context: '上下文',
  skills: '技能',
  reminders: '系统提醒',
  compacted: '压缩后的摘要',
  image: '图片',
  document: '文档',
}
export function itemName(item: ContextPromptItem) {
  if (item.tag === 'turn') return `第 ${item.name} 轮`
  if (item.tag === 'turns') return `更早的 ${item.n ?? 0} 轮`
  if (item.tag === 'more') return `另外 ${item.n ?? 0} 项`
  return names[item.name] ?? item.name
}
export function fmtK(value: number) {
  const n = Math.max(0, Math.round(value || 0))
  const short = (x: number, d: number) => x.toFixed(d).replace(/\.0+$/, '')
  if (n >= 1e6) return `${short(n / 1e6, n >= 1e7 ? 1 : 2)}M`
  if (n >= 1e3) return `${short(n / 1e3, n >= 1e5 ? 0 : 1)}K`
  return String(n)
}
export const pct = (n: number) => `${Math.round(n * 100)}%`
export function health(fill: number): [string, string] {
  return fill < 0.75 ? ['ok', '健康'] : fill < 0.9 ? ['warn', '渐满'] : ['bad', '将满']
}
export function headroom(series: { tokens: number }[], free: number) {
  const steps: number[] = []
  for (let i = 1; i < series.length; i++) {
    const d = series[i].tokens - series[i - 1].tokens
    if (d > 0 && series[i].tokens >= series[i - 1].tokens * 0.6) steps.push(d)
  }
  steps.sort((a, b) => a - b)
  const growth = steps[steps.length >> 1]
  return growth > 0 ? Math.floor(free / growth) : null
}
export function cellsOf(p: ContextPrompt, window: number) {
  const scale = Math.max(window, p.tokens, 1)
  const used = Math.min(400, Math.round((p.tokens / scale) * 400))
  const parts = contextPartKinds
    .map((k) => p.parts.find((x) => x.kind === k))
    .filter((x): x is ContextPromptPart => x !== undefined && x.tokens > 0)
  const sum = parts.reduce((s, x) => s + x.tokens, 0) || 1
  const want = parts.map((x) => (x.tokens / sum) * used)
  const got = want.map((w) => Math.max(1, Math.floor(w)))
  let left = used - got.reduce((s, n) => s + n, 0)
  const order = want.map((w, i) => [w - Math.floor(w), i]).sort((a, b) => b[0] - a[0])
  for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left--) got[order[j][1]]++
  for (let j = got.length - 1; left < 0 && j >= 0; j--)
    while (left < 0 && got[j] > 1) {
      got[j]--
      left++
    }
  const cells: ({ kind: ContextPartKind; item?: ContextPromptItem } | null)[] = []
  parts.forEach((part, pi) => {
    const items = [...part.items].sort((a, b) => b.tokens - a.tokens)
    const isum = items.reduce((s, it) => s + it.tokens, 0) || 1
    let at = 0
    let acc = 0
    for (let c = 0; c < got[pi]; c++) {
      const mid = ((c + 0.5) / got[pi]) * isum
      while (at < items.length - 1 && acc + items[at].tokens < mid) acc += items[at++].tokens
      cells.push({ kind: part.kind, item: items[at] })
    }
  })
  while (cells.length < 400) cells.push(null)
  return cells.slice(0, 400)
}
type Value<T> = T & { v: number }
type Rect<T> = { a: Value<T>; x: number; y: number; w: number; h: number }
function squarify<T>(input: Value<T>[], x: number, y: number, w: number, h: number): Rect<T>[] {
  const out: Rect<T>[] = []
  const vals = input.filter((a) => a.v > 0)
  const total = vals.reduce((s, a) => s + a.v, 0)
  if (!total || w <= 0 || h <= 0) return out
  const k = (w * h) / total
  const worst = (row: Value<T>[], side: number) => {
    let sum = 0
    let hi = 0
    let lo = Infinity
    for (const a of row) {
      const s = a.v * k
      sum += s
      hi = Math.max(hi, s)
      lo = Math.min(lo, s)
    }
    return Math.max((side * side * hi) / (sum * sum), (sum * sum) / (side * side * lo))
  }
  const lay = (row: Value<T>[]) => {
    const sum = row.reduce((s, a) => s + a.v * k, 0)
    if (w >= h) {
      const cw = sum / h
      let cy = y
      for (const a of row) {
        const ch = (a.v * k) / cw
        out.push({ a, x, y: cy, w: cw, h: ch })
        cy += ch
      }
      x += cw
      w -= cw
    } else {
      const rh = sum / w
      let cx = x
      for (const a of row) {
        const cw = (a.v * k) / rh
        out.push({ a, x: cx, y, w: cw, h: rh })
        cx += cw
      }
      y += rh
      h -= rh
    }
  }
  let row: Value<T>[] = []
  for (const a of vals) {
    const side = Math.min(w, h)
    if (!row.length || worst([...row, a], side) <= worst(row, side)) {
      row.push(a)
      continue
    }
    lay(row)
    row = [a]
  }
  if (row.length) lay(row)
  return out
}
export type ContextTile = {
  key: string
  kind: ContextPartKind | ''
  free?: boolean
  it?: ContextPromptItem
  its: ContextPromptItem[]
  tokens: number
  x: number
  y: number
  w: number
  h: number
}
export function tilesOf(p: ContextPrompt, window: number, W: number, H: number): ContextTile[] {
  const scale = Math.max(window, p.tokens, 1)
  const across = W >= H
  const long = across ? W : H
  let usedLen = long
  if (p.tokens < scale) usedLen = Math.min(long, Math.max(long * (p.tokens / scale) ** 0.35, Math.min(long, 36)))
  const tiles: ContextTile[] = []
  const parts = contextPartKinds
    .map((k) => p.parts.find((x) => x.kind === k))
    .filter((x): x is ContextPromptPart => x !== undefined && x.tokens > 0)
  const ur: [number, number, number, number] = across ? [0, 0, usedLen, H] : [0, 0, W, usedLen]
  const floored = <T>(vals: Value<T>[], area: number) => {
    const sum = vals.reduce((s, a) => s + a.v, 0)
    const lo = (sum * 700) / Math.max(1, area)
    return vals.map((a) => ({ ...a, v: Math.max(a.v, lo) }))
  }
  const partVals = floored(
    parts.map((x) => ({ v: x.tokens, part: x })),
    ur[2] * ur[3],
  )
  let partRects = squarify(partVals, ...ur)
  for (let n = 0; n < 8; n++) {
    const thin = partRects.filter((r) => Math.min(r.w, r.h) < 16)
    if (!thin.length) break
    for (const r of thin) r.a.v *= (16 / Math.max(1, Math.min(r.w, r.h))) * 1.05
    partRects = squarify(partVals, ...ur)
  }
  for (const r of partRects) {
    const x = r.a.part
    const items = x.items.filter((it) => it.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    const isum = items.reduce((s, it) => s + it.tokens, 0)
    const area = r.w * r.h
    const base = { kind: x.kind, tokens: x.tokens, x: r.x, y: r.y, w: r.w, h: r.h }
    if (!items.length || area < 3000) {
      tiles.push({ ...base, key: x.kind, its: items })
      continue
    }
    const kept: ContextPromptItem[] = []
    const rest: ContextPromptItem[] = []
    for (const it of items) {
      if (kept.length < 12 && (it.tokens / isum) * area >= 1500) kept.push(it)
      else rest.push(it)
    }
    const vals: Value<{ it?: ContextPromptItem; rest?: ContextPromptItem[] }>[] = kept.map((it) => ({
      v: it.tokens,
      it,
    }))
    if (rest.length === 1 && !kept.length) vals.push({ v: rest[0].tokens, it: rest[0] })
    else if (rest.length) vals.push({ v: rest.reduce((s, it) => s + it.tokens, 0), rest })
    const laid = squarify(floored(vals, area), r.x, r.y, r.w, r.h)
    if (laid.some((q) => Math.min(q.w, q.h) < 14)) {
      tiles.push({ ...base, key: x.kind, its: items })
      continue
    }
    for (const q of laid) {
      const it = q.a.it
      const its = it ? [it] : (q.a.rest ?? [])
      tiles.push({
        key: `${x.kind}\x00${it ? `${it.tag || ''}\x00${it.name}` : '\x01rest'}`,
        kind: x.kind,
        it,
        its,
        tokens: (its.reduce((s, y) => s + y.tokens, 0) / isum) * x.tokens,
        x: q.x,
        y: q.y,
        w: q.w,
        h: q.h,
      })
    }
  }
  if (p.tokens < scale) {
    const fr = across ? [usedLen, 0, W - usedLen, H] : [0, usedLen, W, H - usedLen]
    tiles.push({
      key: '\x00free',
      kind: '',
      free: true,
      its: [],
      tokens: scale - p.tokens,
      x: fr[0],
      y: fr[1],
      w: fr[2],
      h: fr[3],
    })
  }
  return tiles
}
