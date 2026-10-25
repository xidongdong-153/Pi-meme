import { ipcRenderer } from 'electron'
import type { BrowserAnnotation, BrowserRect } from '@pi-meme/contracts/browser'

window.addEventListener('DOMContentLoaded', () => {
  const root = document.createElement('div')
  root.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const shadow = root.attachShadow({ mode: 'closed' })
  const highlight = document.createElement('div')
  highlight.style.cssText =
    'position:fixed;border:2px solid #3997ff;background:#3997ff18;box-sizing:border-box;pointer-events:none;display:none'
  const markers = document.createElement('div')
  const selection = document.createElement('div')
  selection.style.cssText = 'position:fixed;inset:0;cursor:crosshair;pointer-events:none'
  shadow.append(highlight, markers, selection)
  document.documentElement.append(root)
  let documentId = -1
  let enabled = false
  let region = false
  let hidden = false
  let original = false
  let annotations: BrowserAnnotation[] = []
  let dragging: { x: number; y: number } | undefined
  let selected: Element | undefined
  const rect = (box: DOMRect): BrowserRect => ({ x: box.x, y: box.y, width: box.width, height: box.height })
  const draw = (box?: BrowserRect) => {
    highlight.style.display = box && !hidden && !original ? 'block' : 'none'
    if (box)
      Object.assign(highlight.style, {
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      })
  }
  const elementAt = (x: number, y: number) => {
    root.style.display = 'none'
    let element = document.elementFromPoint(x, y)
    root.style.display = ''
    let localX = x
    let localY = y
    while (element?.tagName === 'IFRAME') {
      const frame = element as HTMLIFrameElement
      try {
        const frameDocument = frame.contentDocument
        if (!frameDocument) break
        const frameBox = element.getBoundingClientRect()
        localX -= frameBox.x
        localY -= frameBox.y
        const nested = frameDocument.elementFromPoint(localX, localY)
        if (!nested) break
        element = nested
      } catch {
        break
      }
    }
    while (element?.shadowRoot) {
      const next = element.shadowRoot.elementFromPoint(localX, localY)
      if (!next || next === element) break
      element = next
    }
    return element
  }
  const selectorFor = (element: Element) => {
    const ownerDocument = element.ownerDocument
    if (element.getRootNode() !== ownerDocument) return undefined
    if (element.id && ownerDocument.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1)
      return `#${CSS.escape(element.id)}`
    const parts: string[] = []
    let node: Element | null = element
    while (node && node !== ownerDocument.documentElement && parts.length < 12) {
      const parent: Element | null = node.parentElement
      if (!parent) break
      const siblings = [...parent.children].filter((child) => child.tagName === node!.tagName)
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`)
      node = parent
    }
    return parts.length ? `html > ${parts.join(' > ')}` : undefined
  }
  const topRect = (element: Element): BrowserRect => {
    const box = rect(element.getBoundingClientRect())
    let ownerWindow = element.ownerDocument.defaultView
    while (ownerWindow && ownerWindow !== window) {
      const frame: Element | null = ownerWindow.frameElement
      if (!frame) break
      const frameBox = frame.getBoundingClientRect()
      box.x += frameBox.x
      box.y += frameBox.y
      ownerWindow = frame.ownerDocument.defaultView
    }
    return box
  }
  const framesFor = (element: Element) => {
    const frames: string[] = []
    let ownerWindow = element.ownerDocument.defaultView
    while (ownerWindow && ownerWindow !== window) {
      const frame: Element | null = ownerWindow.frameElement
      const selector = frame && selectorFor(frame)
      if (!frame || !selector) return []
      frames.unshift(selector)
      ownerWindow = frame.ownerDocument.defaultView
    }
    return frames
  }
  /* eslint-disable unicorn/prefer-dom-node-text-content -- 批注只采集可见文本，排除隐藏节点。 */
  const describe = (element: Element | undefined, box: BrowserRect, kind: 'element' | 'region') => {
    const sensitive = element?.closest('input,textarea,[contenteditable="true"]')
    const style = element ? getComputedStyle(element) : undefined
    return {
      documentId,
      kind,
      rect: box,
      selector: element ? selectorFor(element) : undefined,
      frameSelectors: element ? framesFor(element) : undefined,
      frameUrl: element?.ownerDocument.URL,
      tag: element?.tagName.toLowerCase(),
      role: element?.getAttribute('role') ?? undefined,
      name: sensitive ? undefined : element?.getAttribute('aria-label')?.slice(0, 1000),

      text: sensitive
        ? ''
        : ((element && 'innerText' in element ? String(element.innerText) : element?.textContent)?.slice(0, 8000) ??
          ''),
      styles: style
        ? Object.fromEntries(
            [
              'display',
              'position',
              'font-size',
              'color',
              'background-color',
              'padding',
              'margin',
              'gap',
              'border-radius',
            ].map((key) => [key, style.getPropertyValue(key)]),
          )
        : undefined,
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio, scrollX, scrollY },
    }
  }
  /* eslint-enable unicorn/prefer-dom-node-text-content */
  const update = () => {
    if (selected) {
      const box = topRect(selected)
      draw(box)
      ipcRenderer.send('browser:selection-position', box)
    }
    markers.replaceChildren()
    if (hidden || original) return
    annotations.forEach((item, index) => {
      let box = item.rect
      if (item.selector) {
        try {
          let ownerDocument: Document | null = document
          for (const frameSelector of item.frameSelectors ?? []) {
            const frame: Element | null = ownerDocument?.querySelector(frameSelector) ?? null
            ownerDocument = frame?.tagName === 'IFRAME' ? (frame as HTMLIFrameElement).contentDocument : null
          }
          if (!ownerDocument) return
          const matches = ownerDocument.querySelectorAll(item.selector)
          if (matches.length !== 1) return
          box = topRect(matches[0])
        } catch {
          return
        }
      } else box = { ...box, x: box.x + item.viewport.scrollX - scrollX, y: box.y + item.viewport.scrollY - scrollY }
      const marker = document.createElement('span')
      marker.textContent = String(index + 1)
      marker.style.cssText = `position:fixed;left:${Math.max(0, box.x)}px;top:${Math.max(0, box.y)}px;background:#278bff;color:white;font:600 12px system-ui;border:1px solid white;border-radius:10px 10px 10px 2px;padding:4px 7px;pointer-events:none`
      markers.append(marker)
    })
  }
  selection.addEventListener('pointermove', (event) => {
    if (!enabled || original) return
    if (dragging) {
      draw({
        x: Math.min(dragging.x, event.clientX),
        y: Math.min(dragging.y, event.clientY),
        width: Math.abs(event.clientX - dragging.x),
        height: Math.abs(event.clientY - dragging.y),
      })
    } else if (!region) {
      const element = elementAt(event.clientX, event.clientY)
      draw(element ? topRect(element) : undefined)
    }
  })
  selection.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || !enabled || original || event.button !== 0) return
    event.preventDefault()
    if (region) {
      dragging = { x: event.clientX, y: event.clientY }
      selection.setPointerCapture(event.pointerId)
    } else {
      const element = elementAt(event.clientX, event.clientY)
      if (!element) return
      selected = element
      const kind = ['IFRAME', 'CANVAS', 'EMBED', 'OBJECT'].includes(element.tagName) ? 'region' : 'element'
      ipcRenderer.send('browser:selected', describe(element, topRect(element), kind))
    }
  })
  selection.addEventListener('pointerup', (event) => {
    if (!event.isTrusted || !dragging) return
    const box = {
      x: Math.min(dragging.x, event.clientX),
      y: Math.min(dragging.y, event.clientY),
      width: Math.abs(event.clientX - dragging.x),
      height: Math.abs(event.clientY - dragging.y),
    }
    dragging = undefined
    selected = undefined
    if (box.width >= 4 && box.height >= 4) ipcRenderer.send('browser:selected', describe(undefined, box, 'region'))
  })
  selection.addEventListener(
    'wheel',
    (event) => {
      if (enabled && !original) {
        event.preventDefault()
        window.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'instant' })
      }
    },
    { passive: false },
  )
  window.addEventListener('scroll', update, { passive: true, capture: true })
  window.addEventListener('resize', update)
  window.addEventListener('keydown', (event) => {
    if (enabled && event.key === 'Escape') ipcRenderer.send('browser:picker-exit')
  })
  ipcRenderer.on(
    'browser:picker',
    (
      _event,
      state: {
        enabled?: boolean
        region?: boolean
        annotations?: BrowserAnnotation[]
        hidden?: boolean
        original?: boolean
        reset?: boolean
        documentId?: number
      },
    ) => {
      if (state.documentId !== undefined) documentId = state.documentId
      if (state.enabled !== undefined) enabled = state.enabled
      if (state.region !== undefined) region = state.region
      if (state.annotations) annotations = state.annotations
      if (state.hidden !== undefined) hidden = state.hidden
      if (state.original !== undefined) original = state.original
      if (state.reset) {
        selected = undefined
        draw()
      }
      selection.style.pointerEvents = enabled && !original ? 'auto' : 'none'
      if (!enabled || original) draw()
      update()
    },
  )
})
