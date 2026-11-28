import { ipcRenderer } from 'electron'
import type { BrowserAnnotation, BrowserRect } from '@pi-meme/contracts/browser'
import type { ThemeColors } from '@pi-meme/contracts/settings'

type PickerAnnotation = BrowserAnnotation & { markerNumber?: number }
type PickerState = {
  enabled?: boolean
  region?: boolean
  annotations?: PickerAnnotation[]
  hidden?: boolean
  original?: boolean
  reset?: boolean
  documentId?: number
  highlightId?: string | null
  editing?: boolean
  nextNumber?: number
  scrollToId?: string
  colors?: ThemeColors
}

const defaultPalette = {
  accent: '#52a896',
  accentText: '#0e0f11',
  background: '#0e0f11',
  surface: '#141619',
  text: '#d4d7dc',
  muted: '#858b94',
  border: '#272b30',
}

window.addEventListener('DOMContentLoaded', () => {
  const root = document.createElement('div')
  root.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const shadow = root.attachShadow({ mode: 'closed' })

  const highlight = document.createElement('div')
  highlight.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;display:none'

  const tagPill = document.createElement('div')
  tagPill.style.cssText =
    'position:fixed;pointer-events:none;display:none;z-index:3;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 7px;border-radius:7px;font:500 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 4px 12px rgba(0,0,0,0.24)'

  const previewPill = document.createElement('div')
  previewPill.style.cssText =
    'position:fixed;pointer-events:none;display:none;z-index:4;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 9px;border-radius:8px;font:500 12px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.28)'

  const markers = document.createElement('div')
  markers.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2'

  const selection = document.createElement('div')
  selection.style.cssText = 'position:fixed;inset:0;cursor:crosshair;pointer-events:none;z-index:1'

  shadow.append(highlight, markers, selection, tagPill, previewPill)
  document.documentElement.append(root)

  let palette = { ...defaultPalette }
  let documentId = -1
  let enabled = false
  let region = false
  let hidden = false
  let original = false
  let spaceHeld = false
  let nextNumber = 1
  let annotations: PickerAnnotation[] = []
  let dragging: { x: number; y: number } | undefined
  let selected: Element | undefined
  let selectedRegion: { box: BrowserRect; scrollX: number; scrollY: number } | undefined
  let editing = false
  let highlightedId: string | undefined
  let highlightedBox: BrowserRect | undefined
  let highlightedRadius: string | undefined

  const rect = (box: DOMRect): BrowserRect => ({ x: box.x, y: box.y, width: box.width, height: box.height })
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

  const applyPalette = () => {
    tagPill.style.background = palette.surface
    tagPill.style.color = palette.text
    tagPill.style.border = `1px solid ${palette.border}`
    previewPill.style.background = palette.surface
    previewPill.style.color = palette.text
    previewPill.style.border = `1px solid ${palette.border}`
  }
  applyPalette()

  const hideTag = () => {
    tagPill.style.display = 'none'
  }
  const hidePreview = () => {
    previewPill.style.display = 'none'
  }

  const showTag = (box: BrowserRect, label: string, position: 'top' | 'bottom-right' = 'top') => {
    if (!label || hidden || original) {
      hideTag()
      return
    }
    tagPill.textContent = label
    tagPill.style.display = 'block'
    const width = tagPill.offsetWidth || 120
    const height = tagPill.offsetHeight || 20
    if (position === 'bottom-right') {
      const x = clamp(box.x + box.width - width, 6, Math.max(6, innerWidth - width - 6))
      const y = clamp(box.y + box.height + 6, 6, Math.max(6, innerHeight - height - 6))
      tagPill.style.left = `${x}px`
      tagPill.style.top = `${y}px`
      return
    }
    const x = clamp(box.x, 6, Math.max(6, innerWidth - width - 6))
    const y = box.y >= height + 8 ? box.y - height - 6 : clamp(box.y + 6, 6, Math.max(6, innerHeight - height - 6))
    tagPill.style.left = `${x}px`
    tagPill.style.top = `${y}px`
  }

  const showPreview = (anchorX: number, anchorY: number, label: string) => {
    if (!label || hidden || original) {
      hidePreview()
      return
    }
    previewPill.textContent = label
    previewPill.style.display = 'block'
    const width = previewPill.offsetWidth || 160
    const height = previewPill.offsetHeight || 26
    const x = clamp(anchorX, 8, Math.max(8, innerWidth - width - 8))
    const y =
      anchorY >= height + 10 ? anchorY - height - 8 : clamp(anchorY + 30, 8, Math.max(8, innerHeight - height - 8))
    previewPill.style.left = `${x}px`
    previewPill.style.top = `${y}px`
  }

  const draw = (box?: BrowserRect, radius?: string, dashed = false) => {
    const visible = Boolean(box && !hidden && !original)
    highlight.style.display = visible ? 'block' : 'none'
    if (!box) {
      hideTag()
      return
    }
    Object.assign(highlight.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      border: `2px ${dashed ? 'dashed' : 'solid'} ${palette.accent}`,
      background: `color-mix(in srgb, ${palette.accent} 12%, transparent)`,
      borderRadius: radius || '4px',
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
    if (element.id) {
      const idSelector = `#${CSS.escape(element.id)}`
      try {
        if (ownerDocument.querySelectorAll(idSelector).length === 1) return idSelector
      } catch {
        /* 忽略非法 id 兜底走结构路径。 */
      }
    }
    const parts: string[] = []
    let node: Element | null = element
    let anchored = false
    while (node && node !== ownerDocument.documentElement && parts.length < 64) {
      if (node !== element && node.id) {
        const idSelector = `#${CSS.escape(node.id)}`
        try {
          if (ownerDocument.querySelectorAll(idSelector).length === 1) {
            parts.unshift(idSelector)
            anchored = true
            break
          }
        } catch {
          /* 继续向上寻找可靠锚点。 */
        }
      }
      const parent: Element | null = node.parentElement
      if (!parent) break
      const index = [...parent.children].indexOf(node) + 1
      if (index < 1) break
      parts.unshift(`${CSS.escape(node.tagName.toLowerCase())}:nth-child(${index})`)
      node = parent
    }
    if (!parts.length) return undefined
    const candidate = anchored
      ? parts.join(' > ')
      : node === ownerDocument.documentElement
        ? `html > ${parts.join(' > ')}`
        : undefined
    if (!candidate || candidate.length > 7800) return undefined
    try {
      return ownerDocument.querySelectorAll(candidate).length === 1 ? candidate : undefined
    } catch {
      return undefined
    }
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

  const elementTagLabel = (element: Element, box: BrowserRect) => {
    const tag = element.tagName.toLowerCase()
    const id = element.id && element.id.length <= 24 ? `#${element.id}` : ''
    return `${tag}${id} · ${Math.round(box.width)}×${Math.round(box.height)}`
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
              'font-family',
              'font-weight',
              'color',
              'background-color',
              'opacity',
              'padding',
              'margin',
              'gap',
              'border-radius',
              'border-color',
              'border-width',
            ].map((key) => [key, style.getPropertyValue(key)]),
          )
        : undefined,
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio, scrollX, scrollY },
    }
  }
  /* eslint-enable unicorn/prefer-dom-node-text-content */

  const resolveAnnotationTarget = (item: PickerAnnotation) => {
    let element: Element | undefined
    let fallback = false
    let box: BrowserRect = {
      ...item.rect,
      x: item.rect.x + item.viewport.scrollX - scrollX,
      y: item.rect.y + item.viewport.scrollY - scrollY,
    }
    if (item.selector) {
      try {
        let ownerDocument: Document | null = document
        for (const frameSelector of item.frameSelectors ?? []) {
          const frame: Element | null = ownerDocument?.querySelector(frameSelector) ?? null
          ownerDocument = frame?.tagName === 'IFRAME' ? (frame as HTMLIFrameElement).contentDocument : null
        }
        const matches = ownerDocument?.querySelectorAll(item.selector)
        if (matches && matches.length === 1) {
          element = matches[0]
          box = topRect(element)
        } else {
          fallback = true
        }
      } catch {
        fallback = true
      }
    }
    return { box, element, fallback }
  }

  const inViewport = (box: BrowserRect) =>
    box.x + box.width > 0 && box.x < innerWidth && box.y + box.height > 0 && box.y < innerHeight

  const placeAnchor = (box: BrowserRect, placed: Array<{ x: number; y: number }>) => {
    let x = clamp(box.x, 6, Math.max(6, innerWidth - 32))
    let y = box.y >= 30 ? box.y - 26 : clamp(box.y + 4, 6, Math.max(6, innerHeight - 30))
    for (let attempt = 0; attempt < 24; attempt++) {
      const collides = placed.some((point) => Math.hypot(point.x - x, point.y - y) < 20)
      if (!collides) break
      if (x + 26 <= innerWidth - 30) x += 26
      else {
        x = clamp(box.x, 6, Math.max(6, innerWidth - 32))
        y = clamp(y + 26, 6, Math.max(6, innerHeight - 30))
      }
    }
    placed.push({ x, y })
    return { x, y }
  }

  const update = () => {
    if (selected) {
      if (selected.isConnected) {
        const box = topRect(selected)
        draw(box, getComputedStyle(selected).borderRadius, true)
        hideTag()
        ipcRenderer.send('browser:selection-position', box)
      }
    } else if (selectedRegion) {
      const box = {
        ...selectedRegion.box,
        x: selectedRegion.box.x + selectedRegion.scrollX - scrollX,
        y: selectedRegion.box.y + selectedRegion.scrollY - scrollY,
      }
      draw(box, '4px', true)
      hideTag()
      ipcRenderer.send('browser:selection-position', box)
    }
    highlightedBox = undefined
    highlightedRadius = undefined
    hidePreview()
    markers.replaceChildren()
    if (!enabled || hidden || original) return

    const placed: Array<{ x: number; y: number }> = []
    annotations.forEach((item, index) => {
      const { box, fallback } = resolveAnnotationTarget(item)
      if (item.id === highlightedId) {
        highlightedBox = box
        highlightedRadius = item.styles?.['border-radius']
        draw(box, highlightedRadius, false)
        ipcRenderer.send('browser:selection-position', box)
      }
      if (!inViewport(box)) return
      const number = item.markerNumber ?? index + 1
      const anchor = placeAnchor(box, placed)
      const isHighlighted = item.id === highlightedId
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.textContent = String(number)
      marker.setAttribute('aria-label', `编辑第 ${number} 条批注`)
      marker.style.cssText = [
        'position:fixed',
        `left:${anchor.x}px`,
        `top:${anchor.y}px`,
        `background:${palette.accent}`,
        `color:${palette.accentText}`,
        'font:600 12px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif',
        'font-variant-numeric:tabular-nums',
        `border:${fallback ? `1.5px dashed ${palette.background}` : `1.5px solid ${palette.background}`}`,
        'border-radius:12px 12px 12px 3px',
        'min-width:24px',
        'height:24px',
        'padding:0 6px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'cursor:pointer',
        `box-shadow:${isHighlighted ? `0 0 0 2px ${palette.accent}, 0 3px 10px rgba(0,0,0,0.34)` : '0 2px 6px rgba(0,0,0,0.28)'}`,
        `transform:${isHighlighted ? 'scale(1.08)' : 'none'}`,
        `pointer-events:${enabled ? 'auto' : 'none'}`,
      ].join(';')
      marker.addEventListener('click', (event) => {
        event.stopPropagation()
        ipcRenderer.send('browser:marker-click', item.id)
      })
      marker.addEventListener('pointerenter', () => {
        if (!editing) draw(box, item.styles?.['border-radius'], false)
        const targetName = item.kind === 'element' && item.tag ? `<${item.tag}>` : '区域选区'
        const summary = item.comment.trim() || `${targetName}（仅标记）`
        const suffix = fallback ? ' · 位置可能已变动' : ''
        showPreview(anchor.x, anchor.y, `${number} · ${summary}${suffix}`)
      })
      marker.addEventListener('pointerleave', () => {
        hidePreview()
        if (!editing) draw(highlightedBox, highlightedRadius, false)
      })
      markers.append(marker)
    })

    const draftBox = selected?.isConnected
      ? topRect(selected)
      : selectedRegion
        ? {
            ...selectedRegion.box,
            x: selectedRegion.box.x + selectedRegion.scrollX - scrollX,
            y: selectedRegion.box.y + selectedRegion.scrollY - scrollY,
          }
        : undefined
    if (draftBox && inViewport(draftBox)) {
      const anchor = placeAnchor(draftBox, placed)
      const marker = document.createElement('div')
      marker.textContent = String(nextNumber)
      marker.style.cssText = [
        'position:fixed',
        `left:${anchor.x}px`,
        `top:${anchor.y}px`,
        `background:color-mix(in srgb, ${palette.accent} 24%, ${palette.surface})`,
        `color:${palette.accent}`,
        'font:600 12px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif',
        'font-variant-numeric:tabular-nums',
        `border:1.5px dashed ${palette.accent}`,
        'border-radius:12px 12px 12px 3px',
        'min-width:24px',
        'height:24px',
        'padding:0 6px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'box-shadow:0 2px 8px rgba(0,0,0,0.24)',
        'pointer-events:none',
      ].join(';')
      markers.append(marker)
    }
  }

  const scrollToAnnotation = (id: string) => {
    const item = annotations.find((entry) => entry.id === id)
    if (!item) return
    const { element } = resolveAnnotationTarget(item)
    if (element && 'scrollIntoView' in element) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    } else {
      window.scrollTo({
        left: Math.max(0, item.rect.x + item.viewport.scrollX - innerWidth / 2 + item.rect.width / 2),
        top: Math.max(0, item.rect.y + item.viewport.scrollY - innerHeight / 2 + item.rect.height / 2),
        behavior: 'smooth',
      })
    }
    requestAnimationFrame(() => {
      update()
      window.setTimeout(update, 260)
    })
  }

  const releaseSpace = () => {
    if (!spaceHeld) return
    spaceHeld = false
    ipcRenderer.send('browser:original-toggle', false)
  }

  selection.addEventListener('pointermove', (event) => {
    if (!enabled || original) return
    if (dragging) {
      const box = {
        x: Math.min(dragging.x, event.clientX),
        y: Math.min(dragging.y, event.clientY),
        width: Math.abs(event.clientX - dragging.x),
        height: Math.abs(event.clientY - dragging.y),
      }
      draw(box, '4px', true)
      showTag(box, `${Math.round(box.width)} × ${Math.round(box.height)}`, 'bottom-right')
    } else if (!editing && !region) {
      const element = elementAt(event.clientX, event.clientY)
      if (element) {
        const box = topRect(element)
        draw(box, getComputedStyle(element).borderRadius, false)
        showTag(box, elementTagLabel(element, box), 'top')
      } else {
        draw()
      }
    }
  })

  selection.addEventListener('pointerleave', () => {
    if (!editing && !dragging) draw()
  })

  selection.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || !enabled || original || event.button !== 0) return
    event.preventDefault()
    if (region) {
      dragging = { x: event.clientX, y: event.clientY }
      selection.setPointerCapture(event.pointerId)
    } else {
      const element = elementAt(event.clientX, event.clientY)
      if (
        editing &&
        (!element || element === selected || element === document.body || element === document.documentElement)
      ) {
        ipcRenderer.send('browser:selection-dismiss')
        return
      }
      if (!element) return
      const box = topRect(element)
      const kind = ['IFRAME', 'CANVAS', 'EMBED', 'OBJECT'].includes(element.tagName) ? 'region' : 'element'
      selected = element
      selectedRegion = undefined
      highlightedId = undefined
      editing = true
      ipcRenderer.send('browser:selected', describe(element, box, kind))
      update()
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
    if (box.width >= 8 && box.height >= 8) {
      selected = undefined
      selectedRegion = { box, scrollX, scrollY }
      highlightedId = undefined
      editing = true
      ipcRenderer.send('browser:selected', describe(undefined, box, 'region'))
      update()
    } else {
      draw()
      if (editing) ipcRenderer.send('browser:selection-dismiss')
    }
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
  window.addEventListener('blur', releaseSpace)
  window.addEventListener('keydown', (event) => {
    if (!enabled) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (editing) ipcRenderer.send('browser:selection-cancel')
      else ipcRenderer.send('browser:picker-exit')
      return
    }
    if ((event.code === 'Space' || event.key === ' ') && !editing && !dragging && !event.repeat) {
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      event.preventDefault()
      spaceHeld = true
      ipcRenderer.send('browser:original-toggle', true)
    }
  })
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space' || event.key === ' ') releaseSpace()
  })

  ipcRenderer.on('browser:picker', (_event, state: PickerState) => {
    if (state.colors) {
      palette = {
        accent: state.colors.accent || defaultPalette.accent,
        accentText: state.colors.accentText || defaultPalette.accentText,
        background: state.colors.background || defaultPalette.background,
        surface: state.colors.surface || defaultPalette.surface,
        text: state.colors.text || defaultPalette.text,
        muted: state.colors.muted || defaultPalette.muted,
        border: state.colors.border || defaultPalette.border,
      }
      applyPalette()
    }
    if (state.documentId !== undefined) documentId = state.documentId
    if (state.enabled !== undefined) enabled = state.enabled
    if (state.region !== undefined) region = state.region
    if (state.nextNumber !== undefined) nextNumber = state.nextNumber
    if (state.annotations) annotations = state.annotations
    if (state.highlightId !== undefined) {
      highlightedId = state.highlightId ?? undefined
      if (highlightedId) {
        selected = undefined
        selectedRegion = undefined
      }
    }
    if (state.editing !== undefined) editing = state.editing
    if (state.hidden !== undefined) hidden = state.hidden
    if (state.original !== undefined) {
      original = state.original
      if (!original) spaceHeld = false
    }
    if (state.reset) {
      selected = undefined
      selectedRegion = undefined
      highlightedId = undefined
      editing = false
      draw()
    }
    selection.style.pointerEvents = enabled && !original ? 'auto' : 'none'
    selection.style.cursor = region ? 'crosshair' : 'default'
    if (!enabled || original) draw()
    update()
    if (state.scrollToId) scrollToAnnotation(state.scrollToId)
  })
})
