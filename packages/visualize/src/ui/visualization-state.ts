import {
  validateVisualizationState,
  type VisualizationDocument,
  type VisualizationRef,
  type VisualizationState,
} from '@pi-meme/contracts/visualize'
import type { SessionRef } from '@pi-meme/contracts/app-host'

export type VisualizationCapture = { svg: string; width: number; height: number }
type Snapshot = {
  state: VisualizationState
  sequence: number
  draft: string
  sending: boolean
  source: 'live' | 'saved' | 'initial'
}
type CaptureSource = { capture: () => Promise<VisualizationCapture>; visible: () => boolean }

const stores = new Map<string, VisualizationStateStore>()
let listening = false

export function visualizationStorageKey(session: SessionRef, reference: VisualizationRef) {
  return `pi-meme:visualize:v1:${JSON.stringify([session.hostId, session.sessionId])}:${reference.id}:${reference.revision}`
}

export class VisualizationStateStore {
  private snapshot: Snapshot
  private listeners = new Set<() => void>()
  private captures = new Map<symbol, CaptureSource>()
  private notification = 0
  private persistence: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly key: string,
    readonly document: VisualizationDocument,
  ) {
    let state = document.initialState
    let source: Snapshot['source'] = 'initial'
    let draft = ''
    try {
      const saved = localStorage.getItem(key)
      if (saved !== null) {
        const parsed = JSON.parse(saved) as VisualizationState
        validateVisualizationState(parsed, document)
        state = parsed
        source = 'saved'
      }
    } catch {
      // 无效或不可读的本地状态不覆盖已保存版本的初值。
    }
    try {
      draft = localStorage.getItem(`${key}:draft`) ?? ''
    } catch {
      // 存储不可用时继续使用内存草稿。
    }
    this.snapshot = { state: Object.freeze({ ...state }), sequence: 0, draft, sending: false, source }
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.flush()
    }
  }

  private notify() {
    if (this.notification) return
    this.notification = requestAnimationFrame(() => {
      this.notification = 0
      this.listeners.forEach((listener) => listener())
    })
  }

  patch(patch: unknown) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('可视化状态变更无效')
    for (const key of Object.keys(patch)) {
      if (!Object.hasOwn(this.document.initialState, key)) throw new Error(`未声明的可视化状态：${key}`)
    }
    return this.replace({ ...this.snapshot.state, ...patch })
  }

  replace(state: VisualizationState, persist = true) {
    validateVisualizationState(state, this.document)
    if (Object.keys(state).every((key) => state[key] === this.snapshot.state[key])) return this.snapshot
    this.snapshot = {
      ...this.snapshot,
      state: Object.freeze({ ...state }),
      sequence: this.snapshot.sequence + 1,
      source: persist ? 'live' : 'saved',
    }
    if (persist) {
      clearTimeout(this.persistence)
      this.persistence = setTimeout(() => this.flush(), 150)
    }
    this.notify()
    return this.snapshot
  }

  setDraft(draft: string, persist = true) {
    if (draft === this.snapshot.draft) return
    this.snapshot = { ...this.snapshot, draft }
    if (persist) {
      try {
        localStorage.setItem(`${this.key}:draft`, draft)
      } catch {
        // 反馈草稿继续保留在内存。
      }
    }
    this.notify()
  }

  setSending(sending: boolean) {
    this.snapshot = { ...this.snapshot, sending }
    this.notify()
  }

  flush() {
    if (!this.persistence) return
    clearTimeout(this.persistence)
    this.persistence = undefined
    try {
      localStorage.setItem(this.key, JSON.stringify(this.snapshot.state))
    } catch {
      // 本地持久化失败不打断当前交互。
    }
  }

  registerCapture(source: CaptureSource) {
    const id = Symbol('visualization-capture')
    this.captures.set(id, source)
    return () => {
      this.captures.delete(id)
    }
  }

  capture() {
    const source = [...this.captures.values()].reverse().find((candidate) => candidate.visible())
    if (!source) throw new Error('请先打开此版本的可视化，再导出 PNG')
    return source.capture()
  }

  get retained() {
    return this.listeners.size > 0 || this.captures.size > 0 || this.snapshot.sending
  }
}

export function getVisualizationStateStore(key: string, document: VisualizationDocument) {
  let store = stores.get(key)
  if (!store) {
    store = new VisualizationStateStore(key, document)
    stores.set(key, store)
    if (stores.size > 128) {
      for (const [previousKey, previous] of stores) {
        if (previousKey !== key && !previous.retained) {
          previous.flush()
          stores.delete(previousKey)
          if (stores.size <= 128) break
        }
      }
    }
  }
  if (!listening) {
    listening = true
    window.addEventListener('pagehide', () => stores.forEach((value) => value.flush()))
    window.addEventListener('storage', (event) => {
      if (!event.key) return
      const owner = stores.get(event.key)
      if (owner && event.newValue) {
        try {
          owner.replace(JSON.parse(event.newValue) as VisualizationState, false)
        } catch {
          // 其他窗口的非法状态不会进入当前预览。
        }
      }
      if (event.key.endsWith(':draft')) stores.get(event.key.slice(0, -6))?.setDraft(event.newValue ?? '', false)
    })
  }
  return store
}
