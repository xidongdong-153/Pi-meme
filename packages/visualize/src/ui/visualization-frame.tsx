import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { VisualizationDocument } from '@pi-meme/contracts/visualize'
import { Button } from '@pi-meme/ui/components/ui/button'
import { loadVisualizationAssets, loadVisualizationCapture } from './runtime-assets'
import { readVisualizationEnvironment } from './visualization-environment'
import type { VisualizationCapture, VisualizationStateStore } from './visualization-state'

export type VisualizationFrameHandle = { capture: () => Promise<VisualizationCapture> }
type PendingCapture = {
  resolve: (value: VisualizationCapture) => void
  reject: (cause: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const VisualizationFrame = forwardRef<
  VisualizationFrameHandle,
  { document: VisualizationDocument; store: VisualizationStateStore; rich: boolean; onEscape?: () => void }
>(({ document, store, rich, onEscape }, ref) => {
  const frame = useRef<HTMLIFrameElement>(null)
  const port = useRef<MessagePort | null>(null)
  const ready = useRef(false)
  const visible = useRef(true)
  const captures = useRef(new Map<string, PendingCapture>())
  const escape = useRef(onEscape)
  escape.current = onEscape
  const [height, setHeight] = useState(360)
  const [starting, setStarting] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  const capture = useCallback(() => {
    const connected = port.current
    if (!rich || !ready.current || !connected) return Promise.reject(new Error('可视化尚未就绪，请稍后重试'))
    return new Promise<VisualizationCapture>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => {
        captures.current.delete(requestId)
        reject(new Error('生成图像超过 10 秒，请重试'))
      }, 10000)
      captures.current.set(requestId, { resolve, reject, timer })
      void loadVisualizationCapture()
        .then((captureRuntime) => {
          const pending = captures.current.get(requestId)
          if (!pending) return
          if (port.current !== connected || !ready.current) {
            clearTimeout(timer)
            captures.current.delete(requestId)
            reject(new Error('可视化已重新加载，请重试'))
            return
          }
          const snapshot = store.getSnapshot()
          connected.postMessage({ type: 'state', state: snapshot.state, sequence: snapshot.sequence })
          connected.postMessage({ type: 'capture', requestId, captureRuntime })
        })
        .catch((cause: unknown) => {
          if (!captures.current.delete(requestId)) return
          clearTimeout(timer)
          reject(cause instanceof Error ? cause : new Error('图像导出组件加载失败'))
        })
    })
  }, [rich, store])

  useImperativeHandle(ref, () => ({ capture }), [capture])
  useEffect(
    () =>
      store.registerCapture({
        capture,
        visible: () => ready.current && visible.current && Boolean(frame.current?.getClientRects().length),
      }),
    [store, capture],
  )

  useEffect(() => {
    const iframe = frame.current
    if (!iframe) return
    const bridgeToken = crypto.randomUUID()
    let channel: MessageChannel | undefined
    let active = true
    let lastEnvironment = ''
    ready.current = false
    setStarting(true)
    setError('')
    const fail = (message: string) => {
      if (!active) return
      setStarting(false)
      setError(message)
    }
    const timeout = setTimeout(fail, 10000, '可视化未能在 10 秒内启动，请重新加载')
    const environment = () => readVisualizationEnvironment(visible.current)
    const sendEnvironment = () => {
      const value = environment()
      const serialized = JSON.stringify(value)
      if (serialized === lastEnvironment) return
      lastEnvironment = serialized
      channel?.port1.postMessage({ type: 'environment', environment: value })
      // 旧 Host 的运行壳只接收 theme 消息。
      channel?.port1.postMessage({ type: 'theme', values: value.colors })
    }
    const sendState = () => {
      const snapshot = store.getSnapshot()
      channel?.port1.postMessage({ type: 'state', state: snapshot.state, sequence: snapshot.sequence })
    }
    const initialize = () => {
      void (async () => {
        const assets = rich ? await loadVisualizationAssets(document.libraries) : undefined
        if (!active) return
        channel?.port1.close()
        channel = new MessageChannel()
        const connected = channel
        port.current = connected.port1
        connected.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (!active || port.current !== connected.port1 || !data || typeof data !== 'object') return
          const message = data as Record<string, unknown>
          if (message.type === 'escape') escape.current?.()
          if (message.type === 'ready') {
            clearTimeout(timeout)
            ready.current = true
            setStarting(false)
          }
          if (message.type === 'height' && typeof message.height === 'number' && Number.isFinite(message.height)) {
            const next = Math.max(40, Math.min(16384, Math.ceil(message.height)))
            setHeight((previous) => (previous === next ? previous : next))
          }
          if (message.type === 'error') {
            clearTimeout(timeout)
            fail(String(message.message).slice(0, 2000))
          }
          if (message.type === 'patch') {
            if (!Number.isSafeInteger(message.requestId)) return
            try {
              const snapshot = store.patch(message.patch)
              connected.port1.postMessage({ type: 'state', state: snapshot.state, sequence: snapshot.sequence })
              connected.port1.postMessage({
                type: 'reply',
                requestId: message.requestId,
                state: snapshot.state,
                sequence: snapshot.sequence,
              })
            } catch (cause) {
              connected.port1.postMessage({ type: 'reply', requestId: message.requestId, error: String(cause) })
            }
          }
          if (message.type === 'capture-result' && typeof message.requestId === 'string') {
            const pending = captures.current.get(message.requestId)
            if (!pending) return
            captures.current.delete(message.requestId)
            clearTimeout(pending.timer)
            if (message.error) {
              pending.reject(new Error(String(message.error).slice(0, 2000)))
            } else if (
              typeof message.svg === 'string' &&
              message.svg.length <= 16 * 1024 * 1024 &&
              /^data:image\/svg\+xml[;,]/.test(message.svg) &&
              typeof message.width === 'number' &&
              Number.isFinite(message.width) &&
              message.width > 0 &&
              typeof message.height === 'number' &&
              Number.isFinite(message.height) &&
              message.height > 0
            ) {
              pending.resolve({ svg: message.svg, width: message.width, height: message.height })
            } else {
              pending.reject(new Error('可视化返回的图像数据无效或过大'))
            }
          }
        }
        const snapshot = store.getSnapshot()
        const value = environment()
        lastEnvironment = JSON.stringify(value)
        iframe.contentWindow?.postMessage(
          {
            token: bridgeToken,
            html: document.html,
            state: snapshot.state,
            sequence: snapshot.sequence,
            theme: value.colors,
            environment: value,
            assets,
          },
          '*',
          [connected.port2],
        )
      })().catch((cause: unknown) => {
        clearTimeout(timeout)
        fail(cause instanceof Error ? cause.message : '可视化运行环境加载失败')
      })
    }
    const observer = new MutationObserver(sendEnvironment)
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-appearance', 'data-reduced-motion'],
    })
    const intersection = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting
      sendEnvironment()
    })
    intersection.observe(iframe)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    motion.addEventListener('change', sendEnvironment)
    window.document.addEventListener('visibilitychange', sendEnvironment)
    const unsubscribe = store.subscribe(sendState)
    iframe.addEventListener('load', initialize)
    iframe.src = `/visualization-preview?instance=${crypto.randomUUID()}#${bridgeToken}`
    const pendingCaptures = captures.current
    return () => {
      active = false
      ready.current = false
      clearTimeout(timeout)
      observer.disconnect()
      intersection.disconnect()
      unsubscribe()
      motion.removeEventListener('change', sendEnvironment)
      window.document.removeEventListener('visibilitychange', sendEnvironment)
      iframe.removeEventListener('load', initialize)
      channel?.port1.close()
      channel?.port2.close()
      if (port.current === channel?.port1) port.current = null
      pendingCaptures.forEach((pending) => {
        clearTimeout(pending.timer)
        pending.reject(new Error('可视化已关闭或重新加载'))
      })
      pendingCaptures.clear()
    }
  }, [document, store, rich, attempt])

  return (
    <div className="min-w-0 space-y-2">
      <iframe
        ref={frame}
        title={document.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        aria-busy={starting}
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
      {starting && (
        <p role="status" className="ui-loading-delayed text-sm text-muted-foreground">
          正在加载可视化…
        </p>
      )}
      {error && (
        <div className="flex min-w-0 items-start gap-2">
          <p role="alert" className="min-w-0 flex-1 break-words text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      )}
    </div>
  )
})
