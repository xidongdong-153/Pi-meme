import type { StandalonePayload } from '../shared/standalone-types'
import type { VisualizationState } from '@pi-meme/contracts/visualize'

function initializeStandaloneVisualization() {
  const payload = JSON.parse(document.getElementById('visualization-data')!.textContent!) as StandalonePayload
  const frame = document.querySelector('iframe')!
  const heading = document.querySelector('h1')!
  const error = document.querySelector('[role="alert"]') as HTMLElement
  document.title = payload.title
  heading.textContent = payload.title
  const root = document.documentElement
  const environment = { ...payload.environment, visible: document.visibilityState !== 'hidden' }
  root.style.colorScheme = environment.appearance
  root.style.fontFamily = environment.fontFamily
  root.style.fontSize = `${environment.fontSize}px`
  Object.entries(environment.colors).forEach(([key, value]) => root.style.setProperty(key, value))
  let state = { ...payload.state }
  let sequence = 0
  let persistence: ReturnType<typeof setTimeout> | undefined
  let connected: MessagePort | undefined
  function validate(value: unknown): asserts value is VisualizationState {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      new TextEncoder().encode(JSON.stringify(value)).length > 16384
    )
      throw new Error('可视化状态无效')
    const next = value as VisualizationState
    const keys = Object.keys(payload.state)
    if (Object.keys(next).length !== keys.length) throw new Error('可视化状态键不匹配')
    for (const key of keys) {
      if (
        !Object.hasOwn(next, key) ||
        typeof next[key] !== typeof payload.state[key] ||
        (typeof next[key] === 'number' && !Number.isFinite(next[key]))
      )
        throw new Error('可视化状态类型无效')
    }
    for (const control of payload.controls) {
      const item = next[control.key]
      if (control.type === 'select' && !control.options.some((option) => option.value === item))
        throw new Error('选项无效')
      if (control.type === 'toggle' && typeof item !== 'boolean') throw new Error('开关值无效')
      if (control.type === 'color' && (typeof item !== 'string' || !/^#[\da-f]{6}$/i.test(item)))
        throw new Error('颜色值无效')
      if (
        control.type === 'slider' &&
        (typeof item !== 'number' ||
          item < control.min ||
          item > control.max ||
          Math.abs(
            (item - control.min) / (control.step ?? 1) - Math.round((item - control.min) / (control.step ?? 1)),
          ) > 1e-7)
      ) {
        throw new Error('滑杆值无效')
      }
    }
  }
  try {
    const saved = localStorage.getItem(payload.storageKey)
    if (saved) {
      const value: unknown = JSON.parse(saved)
      validate(value)
      state = value
    }
  } catch {
    // 独立文件的存储不可用或旧值无效时使用导出时的状态。
  }
  function persist() {
    clearTimeout(persistence)
    try {
      localStorage.setItem(payload.storageKey, JSON.stringify(state))
    } catch {
      /* 保留当前交互。 */
    }
  }
  const token = crypto.randomUUID()
  const startup = setTimeout(() => {
    error.hidden = false
    error.textContent = '可视化未能在 10 秒内启动，请重新打开文件'
  }, 10000)
  frame.addEventListener('load', () => {
    connected?.close()
    const channel = new MessageChannel()
    connected = channel.port1
    channel.port1.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
      if (!data || typeof data !== 'object') return
      if (data.type === 'ready') clearTimeout(startup)
      if (data.type === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        frame.style.height = `${Math.max(40, Math.min(16384, Math.ceil(data.height)))}px`
      }
      if (data.type === 'error') {
        clearTimeout(startup)
        error.hidden = false
        error.textContent = String(data.message).slice(0, 2000)
      }
      if (data.type === 'patch' && Number.isSafeInteger(data.requestId)) {
        try {
          if (
            !data.patch ||
            typeof data.patch !== 'object' ||
            Array.isArray(data.patch) ||
            Object.keys(data.patch).some((key) => !Object.hasOwn(payload.state, key))
          )
            throw new Error('状态变更无效')
          const next = { ...state, ...data.patch }
          validate(next)
          state = next
          sequence += 1
          channel.port1.postMessage({ type: 'state', state, sequence })
          channel.port1.postMessage({ type: 'reply', requestId: data.requestId, state, sequence })
          clearTimeout(persistence)
          persistence = setTimeout(persist, 150)
        } catch (cause) {
          channel.port1.postMessage({ type: 'reply', requestId: data.requestId, error: String(cause) })
        }
      }
    }
    frame.contentWindow!.postMessage(
      {
        token,
        html: payload.html,
        state,
        sequence,
        theme: environment.colors,
        environment,
        assets: payload.assets,
      },
      '*',
      [channel.port2],
    )
  })
  document.addEventListener('visibilitychange', () =>
    connected?.postMessage({
      type: 'environment',
      environment: { ...environment, visible: document.visibilityState !== 'hidden' },
    }),
  )
  window.addEventListener('pagehide', persist)
  // 不依赖跨源导航时可能被浏览器清空的 window.name。
  frame.srcdoc = payload.shell.replace('<head>', `<head><meta name="pi-visualization-token" content="${token}">`)
}

initializeStandaloneVisualization()
