import type { WebContents } from 'electron'
import {
  browserSnapshotLimits,
  type BrowserAgentElement,
  type BrowserAgentPageSnapshot,
  type BrowserAgentSelectorTarget,
  type BrowserDomCondition,
  type BrowserReadOptions,
  type BrowserSelectOption,
  type BrowserSelectSingleOption,
} from '@pi-meme/contracts/browser-agent'
import { SystemReadError, type ReadErrorCode } from '@pi-meme/contracts/system-read'

export type BrowserPageResolvedTarget = {
  elementId?: string
  x: number
  y: number
  rect: { x: number; y: number; width: number; height: number }
  tag: string
  role: string | null
  isFileInput: boolean
  isEditable: boolean
  isSelect: boolean
  fileSelector?: string
  directValueFallback?: boolean
}

type BrowserPageRequest =
  | { type: 'read'; prefix: string; options?: BrowserReadOptions }
  | { type: 'query'; prefix: string; target: BrowserAgentSelectorTarget; limit: number }
  | {
      type: 'probe'
      condition:
        | BrowserDomCondition
        | { kind: 'selector'; documentId?: number; target: BrowserAgentSelectorTarget; state: 'visible' | 'hidden' }
    }
  | { type: 'resolve'; prefix: string; target: BrowserAgentSelectorTarget; allowHiddenFile?: boolean }
  | {
      type: 'prepareInput'
      prefix: string
      target: BrowserAgentSelectorTarget
      mode: 'replace' | 'append' | 'type'
      text: string
    }
  | { type: 'pasteDom'; prefix: string; target: BrowserAgentSelectorTarget | null; text: string; html?: string }
  | { type: 'focus'; prefix: string; target: BrowserAgentSelectorTarget }
  | { type: 'select'; prefix: string; target: BrowserAgentSelectorTarget; option: BrowserSelectOption }
  | { type: 'scrollPrep'; prefix: string; target?: BrowserAgentSelectorTarget; to?: 'top' | 'bottom' }
  | { type: 'scrollFallback'; deltaX: number; deltaY: number; target?: BrowserAgentSelectorTarget }
  | { type: 'clearFileMarker'; marker: string }

type BrowserPageResults = {
  read: BrowserAgentPageSnapshot
  query: BrowserAgentElement[]
  probe: boolean
  resolve: BrowserPageResolvedTarget
  prepareInput: BrowserPageResolvedTarget & { fallbackApplied: boolean }
  pasteDom: { handled: boolean; x?: number; y?: number }
  focus: null
  select: boolean
  scrollPrep: { x: number; y: number; scrollX: number; scrollY: number; applied: boolean }
  scrollFallback: { x: number; y: number }
  clearFileMarker: null
}

const pageErrors = {
  'stale-document': ['stale-cursor', '网页文档已变化，请重新调用 browser.read'],
  'stale-element': ['stale-cursor', '网页控件已变化，请重新调用 browser.read'],
  'target-not-found': ['not-found', '未找到匹配的网页元素，请重新读取页面或调整选择器'],
  'target-ambiguous': ['invalid-input', '匹配到多个网页元素，请指定 nth 索引或更精确的选择器'],
  'invalid-selector': ['invalid-input', 'CSS 选择器语法无效'],
  'element-disabled': ['disabled', '网页控件已禁用或位于不可操作的区域'],
  'element-unfocusable': ['disabled', '无法将键盘焦点置于指定控件'],
  'not-editable': ['invalid-input', '指定控件不可填写'],
  'not-clickable': ['invalid-input', '指定控件不可点击'],
  'not-select': ['invalid-input', '请选择原生下拉控件'],
  'not-multiple-select': ['invalid-input', '单选下拉控件不支持传入多个选项或清空'],
  'option-missing': ['not-found', '下拉菜单中没有该选项'],
  'option-ambiguous': ['invalid-input', '匹配到多个下拉选项，请使用唯一的值或显示标签'],
  'option-disabled': ['disabled', '下拉选项已禁用或隐藏'],
  'text-empty': ['invalid-input', '等待的文字必须包含非空白字符'],
  'page-timeout': ['timeout', '网页未在截止时间前完成操作，请检查页面状态'],
} as const satisfies Record<string, readonly [ReadErrorCode, string]>

type PageError = keyof typeof pageErrors
type PageResponse<T> = { ok: true; result: T } | { ok: false; reason: PageError }

// This function runs in the guest's isolated world and must have no external runtime references.
function browserAgentPage(
  documentId: number,
  url: string,
  deadline: number,
  limits: typeof browserSnapshotLimits,
  request: BrowserPageRequest,
): PageResponse<BrowserPageResults[keyof BrowserPageResults]> {
  const fail = (reason: PageError) => ({ ok: false as const, reason })
  const ok = <T>(result: T) => ({ ok: true as const, result })
  if (Date.now() >= deadline) return fail('page-timeout')
  if (location.href !== url) return fail('stale-document')

  type Reference = {
    id: string
    element: Element
    identity: string
    frameId?: string
    offsetX: number
    offsetY: number
  }
  const isolated = globalThis as typeof globalThis & {
    piAgentPage?: { documentId: number; url: string; references: Map<string, Reference>; seq: number }
  }
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
  if (!isolated.piAgentPage || isolated.piAgentPage.documentId !== documentId || isolated.piAgentPage.url !== url) {
    isolated.piAgentPage = { documentId, url, references: new Map(), seq: 0 }
  }
  const state = isolated.piAgentPage
  const visible = (element: Element) =>
    element.getClientRects().length > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  const disabled = (element: Element) =>
    element.matches(':disabled') || Boolean(element.closest('[inert], [aria-disabled="true"]'))
  const readOnly = (element: Element) => element.matches('[readonly], [aria-readonly="true"]')
  const optionUnavailable = (option: HTMLOptionElement) => {
    const style = getComputedStyle(option)
    return (
      disabled(option) ||
      Boolean(option.closest('[hidden]')) ||
      style.display === 'none' ||
      style.visibility !== 'visible'
    )
  }

  const interactiveSelector = 'a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable]'
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'gridcell',
    'link',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'scrollbar',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ])
  const nativeRoles: Record<string, string> = {
    button: 'button',
    textarea: 'textbox',
    summary: 'button',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'columnheader',
    progress: 'progressbar',
    output: 'status',
    img: 'img',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  }

  function roleFor(element: Element): string | null {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/, 1)[0]
    if (explicit) return explicit.toLowerCase().slice(0, 64)
    if (element instanceof HTMLInputElement || element.localName === 'input') {
      const inputType = (element.getAttribute('type') ?? 'text').toLowerCase()
      switch (inputType) {
        case 'hidden':
          return null
        case 'checkbox':
          return 'checkbox'
        case 'radio':
          return 'radio'
        case 'range':
          return 'slider'
        case 'number':
          return 'spinbutton'
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
        case 'file':
          return 'button'
        case 'search':
          return element.getAttribute('list') ? 'combobox' : 'searchbox'
        default:
          return element.getAttribute('list') ? 'combobox' : 'textbox'
      }
    }
    if (element instanceof HTMLSelectElement || element.localName === 'select') {
      const el = element as HTMLSelectElement
      return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    }
    if (element.matches('a[href]')) return 'link'
    if (element instanceof HTMLElement && element.isContentEditable) return 'textbox'
    return Object.hasOwn(nativeRoles, element.localName) ? nativeRoles[element.localName] : null
  }

  function renderedText(element: HTMLElement) {
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content
    return element.innerText
  }

  function labelText(label: HTMLLabelElement, control: Element) {
    if (!label.contains(control)) return renderedText(label)
    const range = label.ownerDocument.createRange()
    range.selectNodeContents(label)
    range.setEndBefore(control)
    const before = range.toString()
    range.selectNodeContents(label)
    range.setStartAfter(control)
    return `${before} ${range.toString()}`
  }

  function nameFor(element: Element, role: string | null): string {
    const doc = element.ownerDocument
    const labelledBy = element.getAttribute('aria-labelledby')?.trim()
    if (labelledBy) {
      const text = normalize(
        labelledBy
          .split(/\s+/)
          .map((id) => doc.getElementById(id)?.textContent ?? '')
          .join(' '),
      )
      if (text) return text.slice(0, 300)
    }
    const ariaLabel = normalize(element.getAttribute('aria-label') ?? '')
    if (ariaLabel) return ariaLabel.slice(0, 300)
    if (
      element.localName === 'input' ||
      element.localName === 'select' ||
      element.localName === 'textarea' ||
      element.localName === 'button'
    ) {
      const labels = (element as HTMLInputElement).labels
      if (labels) {
        const text = normalize(Array.from(labels, (label) => labelText(label, element)).join(' '))
        if (text) return text.slice(0, 300)
      }
    }
    const alt = element.getAttribute('alt') ?? element.querySelector('img[alt]')?.getAttribute('alt') ?? ''
    if (element.localName === 'input' && ['button', 'submit', 'reset'].includes((element as HTMLInputElement).type))
      return normalize((element as HTMLInputElement).value || alt || element.getAttribute('title') || '').slice(0, 300)
    const fromContent = role !== 'textbox' && !['input', 'select', 'textarea'].includes(element.localName)
    const content = fromContent ? (element instanceof HTMLElement ? renderedText(element) : element.textContent) : ''
    return normalize(
      content || alt || element.getAttribute('title') || element.getAttribute('placeholder') || '',
    ).slice(0, 300)
  }

  function identityOf(element: Element, role: string | null, name: string) {
    const form = (element as HTMLInputElement).form ?? null
    return JSON.stringify([
      element.localName,
      role,
      name,
      element.getAttribute('type'),
      element.getAttribute('name'),
      element.getAttribute('href'),
      element.getAttribute('target'),
      form?.action,
      form?.method,
      element.getAttribute('formaction'),
      element.getAttribute('formmethod'),
    ])
  }

  function sanitizeHref(element: Element): string | undefined {
    const raw = element.getAttribute('href')
    if (!raw) return undefined
    try {
      const parsed = new URL(raw, element.ownerDocument.baseURI)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.href.slice(0, 2048)
    } catch {
      return undefined
    }
  }

  function readValue(element: Element, name: string) {
    if (element.localName === 'input') {
      const input = element as HTMLInputElement
      if (['password', 'file', 'hidden'].includes(input.type)) return undefined
      if (/\b(?:one-time-code|current-password|new-password|cc-number|cc-csc)\b/i.test(input.autocomplete))
        return undefined
      const labels = `${name} ${input.name} ${input.id}`.replace(/[_-]/g, ' ')
      if (/\b(?:password|passcode|otp|2fa|verification *code|one *time *(?:password|code))\b|密码|验证码/i.test(labels))
        return undefined
    }
    if (['input', 'select', 'textarea', 'button'].includes(element.localName)) {
      return ((element as HTMLInputElement).value ?? '').slice(0, 1024)
    }
    return undefined
  }

  function ariaState(element: Element, attribute: string) {
    const value = element.getAttribute(attribute)
    return value === 'true' ? true : value === 'false' ? false : undefined
  }

  function isScrollableElement(element: Element) {
    if (element.scrollHeight <= element.clientHeight + 2 && element.scrollWidth <= element.clientWidth + 2) return false
    const style = getComputedStyle(element)
    return /auto|scroll/.test(`${style.overflowY} ${style.overflowX}`)
  }

  type Collected = { element: Element; frameId?: string; offsetX: number; offsetY: number }

  function walkDom(
    rootNode: ParentNode,
    frameId: string | undefined,
    offsetX: number,
    offsetY: number,
    visitor: (item: Collected) => boolean | void,
  ): boolean {
    const doc = rootNode instanceof Document ? rootNode : (rootNode.ownerDocument ?? document)
    const walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT)
    let current = rootNode instanceof Element ? rootNode : walker.nextNode()
    while (current) {
      if (Date.now() >= deadline) return false
      if (current instanceof Element) {
        if (visitor({ element: current, frameId, offsetX, offsetY }) === false) return true
        if (current.shadowRoot) {
          if (!walkDom(current.shadowRoot, frameId, offsetX, offsetY, visitor)) return false
        }
        if (current.localName === 'iframe') {
          const frame = current as HTMLIFrameElement
          try {
            const frameDoc = frame.contentDocument
            if (frameDoc && visible(frame)) {
              const box = frame.getBoundingClientRect()
              const style = getComputedStyle(frame)
              const nextX =
                offsetX +
                box.x +
                (Number.parseFloat(style.borderLeftWidth) || 0) +
                (Number.parseFloat(style.paddingLeft) || 0)
              const nextY =
                offsetY +
                box.y +
                (Number.parseFloat(style.borderTopWidth) || 0) +
                (Number.parseFloat(style.paddingTop) || 0)
              const childFrameId = frameId
                ? `${frameId}/${frame.name || 'frame'}`
                : `frame:${frame.id || frame.name || `${Math.round(box.x)},${Math.round(box.y)}`}`
              if (!walkDom(frameDoc, childFrameId, nextX, nextY, visitor)) return false
            }
          } catch {
            // Cross-origin iframe is handled via CDP Accessibility tree.
          }
        }
      }
      current = walker.nextNode()
    }
    return true
  }

  function isInteractiveCandidate(element: Element, role: string | null) {
    if (element.localName === 'input' && (element as HTMLInputElement).type === 'hidden') return false
    if (
      element.matches(interactiveSelector) &&
      (element.matches('a,button,input,textarea,select,summary,[tabindex]') ||
        (element instanceof HTMLElement && element.isContentEditable) ||
        (role !== null && interactiveRoles.has(role)))
    ) {
      return true
    }
    if (!visible(element)) return false
    const style = getComputedStyle(element)
    if (style.cursor === 'pointer') {
      const box = element.getBoundingClientRect()
      if (box.width >= 8 && box.height >= 8 && box.width <= 1200 && box.height <= 360) {
        if (!element.querySelector('a,button,input,textarea,select,[role="button"],[role="link"]')) {
          const txt = normalize(element.textContent ?? '')
          if (txt.length <= 160) return true
        }
      }
    }
    return false
  }

  function registerReference(
    prefix: string,
    element: Element,
    role: string | null,
    name: string,
    frameId: string | undefined,
    offsetX: number,
    offsetY: number,
  ) {
    const identity = identityOf(element, role, name)
    for (const ref of state.references.values()) {
      if (ref.element === element && ref.identity === identity) {
        ref.frameId = frameId
        ref.offsetX = offsetX
        ref.offsetY = offsetY
        return ref.id
      }
    }
    const id = `${prefix}:${state.seq++}`
    state.references.set(id, { id, element, identity, frameId, offsetX, offsetY })
    while (state.references.size > limits.maxElements * 4) {
      const oldest = state.references.keys().next().value
      if (oldest === undefined) break
      state.references.delete(oldest)
    }
    return id
  }

  function projectElement(
    prefix: string,
    item: Collected,
    remainingOptions: { value: number },
  ): BrowserAgentElement | undefined {
    const { element, frameId, offsetX, offsetY } = item
    const role = roleFor(element)
    if (!isInteractiveCandidate(element, role)) return undefined
    if (!visible(element)) return undefined
    const name = nameFor(element, role)
    const id = registerReference(prefix, element, role, name, frameId, offsetX, offsetY)
    const box = element.getBoundingClientRect()
    const rect = {
      x: Math.round(box.x + offsetX),
      y: Math.round(box.y + offsetY),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
    const inViewport =
      rect.y + rect.height > 0 && rect.y < innerHeight && rect.x + rect.width > 0 && rect.x < innerWidth
    const effectiveRole = role ?? (getComputedStyle(element).cursor === 'pointer' ? 'button' : null)
    const result: BrowserAgentElement = {
      id,
      tag: element.localName.slice(0, 128),
      role: effectiveRole,
      name,
      type: element.getAttribute('type')?.slice(0, 64) ?? null,
      value: readValue(element, name),
      ...(sanitizeHref(element) ? { href: sanitizeHref(element) } : {}),
      rect,
      inViewport,
      ...(isScrollableElement(element) ? { scrollable: true } : {}),
      ...(frameId ? { frameId } : {}),
      disabled: disabled(element),
      readOnly: readOnly(element),
      checked:
        element.localName === 'input' && ['checkbox', 'radio'].includes((element as HTMLInputElement).type)
          ? (element as HTMLInputElement).indeterminate
            ? 'mixed'
            : (element as HTMLInputElement).checked
          : element.getAttribute('aria-checked') === 'mixed'
            ? 'mixed'
            : ariaState(element, 'aria-checked'),
      selected: ariaState(element, 'aria-selected'),
      expanded: ariaState(element, 'aria-expanded'),
    }
    if (element.localName === 'select') {
      const sel = element as HTMLSelectElement
      if (sel.multiple) result.multiple = true
      const count = Math.min(sel.options.length, remainingOptions.value, limits.optionsPerElement)
      result.options = []
      result.optionsTruncated = count < sel.options.length
      for (let index = 0; index < count; index++) {
        const option = sel.options[index]
        const optLabel = option.label.slice(0, 300)
        const optValue = option.value.length <= 1024 ? option.value : undefined
        result.optionsTruncated ||= option.label !== optLabel || optValue === undefined
        result.options.push({
          label: optLabel,
          value: optValue,
          selected: option.selected,
          disabled: optionUnavailable(option),
        })
      }
      remainingOptions.value -= count
    }
    return result
  }

  function findMatches(
    target: BrowserAgentSelectorTarget,
    options?: { allowHiddenFile?: boolean },
  ): { items: Collected[]; error?: PageError } {
    if (typeof target === 'string' || ('elementId' in target && typeof target.elementId === 'string')) {
      const id = typeof target === 'string' ? target : target.elementId
      const ref = state.references.get(id)
      if (!ref || !ref.element.isConnected) return { items: [], error: 'stale-element' }
      const isHiddenFile =
        options?.allowHiddenFile &&
        ref.element.localName === 'input' &&
        (ref.element as HTMLInputElement).type === 'file'
      if (!isHiddenFile && !visible(ref.element)) return { items: [], error: 'stale-element' }
      const role = roleFor(ref.element)
      if (identityOf(ref.element, role, nameFor(ref.element, role)) !== ref.identity) {
        return { items: [], error: 'stale-element' }
      }
      return {
        items: [{ element: ref.element, frameId: ref.frameId, offsetX: ref.offsetX, offsetY: ref.offsetY }],
      }
    }

    const items: Collected[] = []
    if ('css' in target) {
      let validCss = true
      try {
        document.querySelector(target.css)
      } catch {
        validCss = false
      }
      if (!validCss) return { items: [], error: 'invalid-selector' }

      const seen = new Set<Element>()
      const scanCss = (rootNode: ParentNode, frameId: string | undefined, ox: number, oy: number): boolean => {
        if (Date.now() >= deadline) return false
        for (const el of rootNode.querySelectorAll(target.css)) {
          if (seen.has(el)) continue
          seen.add(el)
          const isHiddenFile =
            options?.allowHiddenFile && el.localName === 'input' && (el as HTMLInputElement).type === 'file'
          if (isHiddenFile || visible(el)) {
            items.push({ element: el, frameId, offsetX: ox, offsetY: oy })
          }
        }
        const walker = (
          rootNode instanceof Document ? rootNode : (rootNode.ownerDocument ?? document)
        ).createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT)
        let cur = rootNode instanceof Element ? rootNode : walker.nextNode()
        while (cur) {
          if (Date.now() >= deadline) return false
          if (cur instanceof Element) {
            if (cur.shadowRoot && !scanCss(cur.shadowRoot, frameId, ox, oy)) return false
            if (cur.localName === 'iframe') {
              const frame = cur as HTMLIFrameElement
              try {
                const frameDoc = frame.contentDocument
                if (frameDoc && visible(frame)) {
                  const box = frame.getBoundingClientRect()
                  const style = getComputedStyle(frame)
                  const nx =
                    ox +
                    box.x +
                    (Number.parseFloat(style.borderLeftWidth) || 0) +
                    (Number.parseFloat(style.paddingLeft) || 0)
                  const ny =
                    oy +
                    box.y +
                    (Number.parseFloat(style.borderTopWidth) || 0) +
                    (Number.parseFloat(style.paddingTop) || 0)
                  const fid = frameId ? `${frameId}/frame` : `frame:${frame.id || frame.name || 'sub'}`
                  if (!scanCss(frameDoc, fid, nx, ny)) return false
                }
              } catch {
                // Ignore cross-origin frame.
              }
            }
          }
          cur = walker.nextNode()
        }
        return true
      }
      if (!scanCss(document, undefined, 0, 0)) return { items: [], error: 'page-timeout' }
      return { items }
    }

    if ('role' in target) {
      const targetRole = target.role.toLowerCase()
      const targetName = target.name !== undefined ? normalize(target.name) : undefined
      const exact = target.exact === true
      const done = walkDom(document, undefined, 0, 0, (entry) => {
        if (!visible(entry.element)) return
        const elRole = roleFor(entry.element)
        if (elRole !== targetRole) return
        if (targetName !== undefined) {
          const elName = nameFor(entry.element, elRole)
          if (exact ? elName !== targetName : !elName.toLowerCase().includes(targetName.toLowerCase())) return
        }
        items.push(entry)
      })
      if (!done) return { items: [], error: 'page-timeout' }
      return { items }
    }

    if ('text' in target) {
      const needle = normalize(target.text)
      if (!needle) return { items: [], error: 'text-empty' }
      const exact = target.exact === true
      const lowerNeedle = needle.toLowerCase()
      const allMatched: Collected[] = []
      const done = walkDom(document, undefined, 0, 0, (entry) => {
        const el = entry.element
        if (!visible(el)) return
        const txt = normalize(el instanceof HTMLElement ? renderedText(el) : (el.textContent ?? ''))
        if (!txt) return
        const matches = exact ? txt === needle : txt.toLowerCase().includes(lowerNeedle)
        if (matches) allMatched.push(entry)
      })
      if (!done) return { items: [], error: 'page-timeout' }
      // Keep leaf-most matches (skip ancestors that contain another matched element).
      for (let i = 0; i < allMatched.length; i++) {
        const candidate = allMatched[i]
        const hasChildMatch = allMatched.some((other, j) => j !== i && candidate.element.contains(other.element))
        if (!hasChildMatch) items.push(candidate)
      }
      return { items }
    }

    return { items: [], error: 'target-not-found' }
  }

  function resolveSingle(
    target: BrowserAgentSelectorTarget,
    options?: { allowHiddenFile?: boolean },
  ): { item?: Collected; error?: PageError } {
    const { items, error } = findMatches(target, options)
    if (error) return { error }
    if (!items.length) return { error: 'target-not-found' }
    const nth = typeof target === 'object' && target !== null && 'nth' in target ? target.nth : undefined
    if (nth !== undefined) {
      const idx = nth < 0 ? items.length + nth : nth
      if (idx < 0 || idx >= items.length) return { error: 'target-not-found' }
      return { item: items[idx] }
    }
    if (items.length > 1) return { error: 'target-ambiguous' }
    return { item: items[0] }
  }

  function computeResolvedMeta(prefix: string, item: Collected, allowHiddenFile = false): BrowserPageResolvedTarget {
    const el = item.element
    if (!allowHiddenFile) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    }
    // Recompute iframe offset if inside a same-origin iframe after scroll.
    let ox = 0
    let oy = 0
    let curWin = el.ownerDocument.defaultView
    while (curWin && curWin !== window) {
      const frame = curWin.frameElement
      if (!frame) break
      const fbox = frame.getBoundingClientRect()
      const fstyle = getComputedStyle(frame)
      ox += fbox.x + (Number.parseFloat(fstyle.borderLeftWidth) || 0) + (Number.parseFloat(fstyle.paddingLeft) || 0)
      oy += fbox.y + (Number.parseFloat(fstyle.borderTopWidth) || 0) + (Number.parseFloat(fstyle.paddingTop) || 0)
      curWin = frame.ownerDocument.defaultView
    }
    const box = el.getBoundingClientRect()
    const rect = {
      x: Math.round(box.x + ox),
      y: Math.round(box.y + oy),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
    const role = roleFor(el)
    const name = nameFor(el, role)
    const id = registerReference(prefix, el, role, name, item.frameId, ox, oy)
    const isFileInput = el.localName === 'input' && (el as HTMLInputElement).type === 'file'
    const isSelect = el.localName === 'select'
    const isEditable =
      (el instanceof HTMLElement && el.isContentEditable) ||
      el.localName === 'textarea' ||
      (el.localName === 'input' &&
        !['file', 'hidden', 'button', 'submit', 'reset', 'checkbox', 'radio'].includes((el as HTMLInputElement).type))
    return {
      elementId: id,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      rect,
      tag: el.localName,
      role,
      isFileInput,
      isEditable,
      isSelect,
    }
  }

  function collectAllText(rootNode: ParentNode): string {
    const chunks: string[] = []
    let total = 0
    const maxCapture = limits.text + 1024
    const rootEl = rootNode instanceof Document ? rootNode.body : rootNode instanceof HTMLElement ? rootNode : null
    if (rootEl) {
      const base = renderedText(rootEl)
      if (base) {
        chunks.push(base)
        total += base.length
      }
    }
    if (total < maxCapture) {
      walkDom(rootNode, undefined, 0, 0, ({ element }) => {
        if (total >= maxCapture) return false
        if (element.shadowRoot) {
          const shadowText = normalize(element.shadowRoot.textContent ?? '')
          if (shadowText) {
            chunks.push(shadowText)
            total += shadowText.length
          }
        }
        if (element.localName === 'iframe') {
          try {
            const frameDoc = (element as HTMLIFrameElement).contentDocument
            if (frameDoc?.body && visible(element)) {
              const ft = renderedText(frameDoc.body)
              if (ft) {
                chunks.push(ft)
                total += ft.length
              }
            }
          } catch {
            // Cross-origin frame ignored.
          }
        }
      })
    }
    return chunks.join('\n')
  }

  function visibleTextMatches(body: HTMLElement, needle: string): boolean | undefined {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) =>
        node instanceof Text || node instanceof HTMLBRElement ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    })
    const range = document.createRange()
    const chunks: string[] = []
    let previousBlock: Element | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (Date.now() >= deadline) return undefined
      if (node instanceof HTMLBRElement) {
        if (visible(node)) chunks.push(' ')
        continue
      }
      let parent = node.parentElement
      while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement
      if (!parent || !parent.checkVisibility({ opacityProperty: true }) || !node.textContent) continue
      range.selectNodeContents(node)
      if (!range.getClientRects().length || getComputedStyle(node.parentElement ?? parent).visibility !== 'visible')
        continue
      let block: Element = parent
      while (block.parentElement && /^(?:inline|contents)/.test(getComputedStyle(block).display))
        block = block.parentElement
      if (previousBlock && block !== previousBlock) chunks.push(' ')
      previousBlock = block
      chunks.push(node.textContent)
    }
    if (normalize(chunks.join('')).includes(needle)) return true
    return normalize(collectAllText(document)).includes(needle)
  }

  if (request.type === 'clearFileMarker') {
    const attr = `[data-pi-file-target="${CSS.escape(request.marker)}"]`
    const clearInRoot = (rootNode: ParentNode) => {
      for (const el of rootNode.querySelectorAll(attr)) el.removeAttribute('data-pi-file-target')
    }
    clearInRoot(document)
    walkDom(document, undefined, 0, 0, ({ element }) => {
      if (element.shadowRoot) clearInRoot(element.shadowRoot)
      if (element.localName === 'iframe') {
        try {
          const frameDoc = (element as HTMLIFrameElement).contentDocument
          if (frameDoc) clearInRoot(frameDoc)
        } catch {
          // Cross-origin frame ignored.
        }
      }
    })
    return ok(null)
  }

  if (request.type === 'probe') {
    const condition = request.condition
    if (condition.kind === 'text') {
      const text = normalize(condition.text)
      if (!text) return fail('text-empty')
      const found = document.body ? visibleTextMatches(document.body, text) : false
      if (found === undefined) return fail('page-timeout')
      return ok(found === (condition.state === 'visible'))
    }
    if (condition.kind === 'selector') {
      const { items, error } = findMatches(condition.target)
      if (error && error !== 'stale-element') return fail(error)
      const isVisible = items.length > 0
      return ok(isVisible === (condition.state === 'visible'))
    }
    const role = condition.role
    const name = normalize(condition.name)
    let matched = false
    const done = walkDom(document, undefined, 0, 0, (entry) => {
      if (roleFor(entry.element) === role && visible(entry.element) && nameFor(entry.element, role) === name) {
        matched = true
        return false
      }
    })
    if (!done) return fail('page-timeout')
    return ok(matched ? condition.state === 'visible' : condition.state === 'hidden')
  }

  if (request.type === 'read') {
    const opts = request.options ?? {}
    const scope = opts.scope ?? 'viewport'
    const maxElements = Math.min(opts.maxElements ?? limits.elements, limits.maxElements)
    const offset = opts.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0
    let rootNode: ParentNode = document
    let rootOx = 0
    let rootOy = 0
    let rootFrameId: string | undefined
    if (scope === 'subtree' && opts.root) {
      const { item, error } = resolveSingle(opts.root)
      if (error || !item) return fail(error ?? 'target-not-found')
      rootNode = item.element
      rootOx = item.offsetX
      rootOy = item.offsetY
      rootFrameId = item.frameId
    } else if (opts.frameId?.startsWith('frame:')) {
      let matchedFrame: HTMLIFrameElement | undefined
      let matchedOx = 0
      let matchedOy = 0
      walkDom(document, undefined, 0, 0, (entry) => {
        if (entry.element.localName === 'iframe') {
          const frame = entry.element as HTMLIFrameElement
          const box = frame.getBoundingClientRect()
          const fid = entry.frameId
            ? `${entry.frameId}/${frame.name || 'frame'}`
            : `frame:${frame.id || frame.name || `${Math.round(box.x)},${Math.round(box.y)}`}`
          if (fid === opts.frameId) {
            matchedFrame = frame
            const style = getComputedStyle(frame)
            matchedOx =
              entry.offsetX +
              box.x +
              (Number.parseFloat(style.borderLeftWidth) || 0) +
              (Number.parseFloat(style.paddingLeft) || 0)
            matchedOy =
              entry.offsetY +
              box.y +
              (Number.parseFloat(style.borderTopWidth) || 0) +
              (Number.parseFloat(style.paddingTop) || 0)
            return false
          }
        }
      })
      if (!matchedFrame) return fail('target-not-found')
      try {
        if (!matchedFrame.contentDocument) return fail('target-not-found')
        rootNode = matchedFrame.contentDocument
        rootOx = matchedOx
        rootOy = matchedOy
        rootFrameId = opts.frameId
      } catch {
        return fail('target-not-found')
      }
    }
    const collected: BrowserAgentElement[] = []
    const remainingOptions = { value: limits.options }
    const done = walkDom(rootNode, rootFrameId, rootOx, rootOy, (entry) => {
      const projected = projectElement(request.prefix, entry, remainingOptions)
      if (!projected) return
      if (scope === 'viewport' && projected.rect) {
        const top = projected.rect.y
        const bottom = top + projected.rect.height
        if (bottom < -120 || top > innerHeight + 120) return
      }
      collected.push(projected)
    })
    if (!done) return fail('page-timeout')
    const pageElements = collected.slice(offset, offset + maxElements)
    const nextOffset = offset + pageElements.length
    const nextCursor = nextOffset < collected.length ? String(nextOffset) : undefined
    const rawText = opts.includeText === false ? '' : collectAllText(rootNode)
    const scrollEl = document.scrollingElement ?? document.documentElement
    const viewport = {
      width: Math.round(innerWidth),
      height: Math.round(innerHeight),
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      scrollHeight: Math.round(scrollEl?.scrollHeight ?? innerHeight),
      scrollWidth: Math.round(scrollEl?.scrollWidth ?? innerWidth),
    }
    return ok({
      title: document.title.slice(0, 512),
      text: rawText.slice(0, limits.text),
      elements: pageElements,
      truncated: {
        text: rawText.length > limits.text,
        elements: nextCursor !== undefined,
      },
      viewport,
      hasMoreBelow: viewport.scrollY + viewport.height < viewport.scrollHeight - 4,
      totalElements: collected.length,
      ...(nextCursor ? { nextCursor } : {}),
    })
  }

  if (request.type === 'query') {
    const { items, error } = findMatches(request.target)
    if (error) return fail(error)
    const remainingOptions = { value: limits.options }
    const matches: BrowserAgentElement[] = []
    for (const item of items) {
      if (matches.length >= request.limit) break
      const projected = projectElement(request.prefix, item, remainingOptions)
      if (projected) matches.push(projected)
    }
    return ok(matches)
  }

  if (request.type === 'resolve') {
    const { item, error } = resolveSingle(request.target, { allowHiddenFile: request.allowHiddenFile })
    if (error || !item) return fail(error ?? 'target-not-found')
    if (disabled(item.element)) return fail('element-disabled')
    const meta = computeResolvedMeta(request.prefix, item, request.allowHiddenFile)
    if (request.allowHiddenFile && meta.isFileInput) {
      const marker = `${request.prefix}-file`
      item.element.setAttribute('data-pi-file-target', marker)
      meta.fileSelector = marker
    }
    return ok(meta)
  }

  if (request.type === 'focus') {
    const { item, error } = resolveSingle(request.target)
    if (error || !item) return fail(error ?? 'target-not-found')
    const element = item.element
    if (disabled(element)) return fail('element-disabled')
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return fail('element-unfocusable')
    if (element.ownerDocument.activeElement !== element) element.focus({ preventScroll: true })
    if (location.href !== url) return fail('stale-document')
    return ok(null)
  }

  if (request.type === 'prepareInput') {
    const { item, error } = resolveSingle(request.target)
    if (error || !item) return fail(error ?? 'target-not-found')
    const element = item.element
    if (disabled(element)) return fail('element-disabled')
    if (readOnly(element)) return fail('not-editable')
    const meta = computeResolvedMeta(request.prefix, item)
    if (!meta.isEditable) return fail('not-editable')
    if (element instanceof HTMLElement) element.focus({ preventScroll: true })
    let fallbackApplied = false
    if (element.localName === 'input' || element.localName === 'textarea') {
      const input = element as HTMLInputElement | HTMLTextAreaElement
      const nonTextInput =
        element.localName === 'input' &&
        ['date', 'datetime-local', 'month', 'time', 'week', 'color', 'range'].includes(
          (element as HTMLInputElement).type,
        )
      const setNativeInputValue = (el: HTMLInputElement, next: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        if (descriptor?.set) descriptor.set.call(el, next)
        else el.value = next
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (nonTextInput) {
        setNativeInputValue(input as HTMLInputElement, request.text)
        fallbackApplied = true
      } else if (request.mode === 'replace') {
        input.select()
      } else if (request.mode === 'append') {
        const len = input.value.length
        try {
          input.setSelectionRange(len, len)
        } catch {
          if (element.localName === 'input') {
            setNativeInputValue(input as HTMLInputElement, `${input.value}${request.text}`)
            fallbackApplied = true
          }
        }
      }
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      const doc = element.ownerDocument
      const sel = doc.getSelection()
      if (sel) {
        const range = doc.createRange()
        range.selectNodeContents(element)
        if (request.mode === 'append' || request.mode === 'type') range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    return ok({ ...meta, fallbackApplied })
  }

  if (request.type === 'pasteDom') {
    let targetEl: Element | null = document.activeElement
    if (request.target !== null) {
      const { item, error } = resolveSingle(request.target)
      if (error || !item) return fail(error ?? 'target-not-found')
      if (disabled(item.element)) return fail('element-disabled')
      if (readOnly(item.element)) return fail('not-editable')
      const meta = computeResolvedMeta(request.prefix, item)
      targetEl = item.element
      if (targetEl instanceof HTMLElement) targetEl.focus({ preventScroll: true })
      if (!request.html) return ok({ handled: false, x: meta.x, y: meta.y })
    }
    if (request.html && targetEl instanceof HTMLElement && targetEl.isContentEditable) {
      const dt = new DataTransfer()
      dt.setData('text/plain', request.text)
      dt.setData('text/html', request.html)
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      const notCanceled = targetEl.dispatchEvent(pasteEvent)
      if (!notCanceled) return ok({ handled: true })
      const doc = targetEl.ownerDocument
      if (typeof doc.execCommand === 'function') {
        doc.execCommand('insertHTML', false, request.html)
        return ok({ handled: true })
      }
    }
    return ok({ handled: false })
  }

  if (request.type === 'select') {
    const { item, error } = resolveSingle(request.target)
    if (error || !item) return fail(error ?? 'target-not-found')
    const element = item.element
    if (disabled(element)) return fail('element-disabled')
    if (element.localName !== 'select') return fail('not-select')
    if (readOnly(element)) return fail('not-editable')
    const sel = element as HTMLSelectElement
    const isArray = Array.isArray(request.option)
    if (isArray && !sel.multiple) return fail('not-multiple-select')
    const specs: BrowserSelectSingleOption[] = isArray
      ? (request.option as BrowserSelectSingleOption[])
      : [request.option as BrowserSelectSingleOption]

    const resolvedOptions: HTMLOptionElement[] = []
    for (const spec of specs) {
      if ('index' in spec) {
        const option = sel.options[spec.index]
        if (!option) return fail('option-missing')
        if (optionUnavailable(option)) return fail('option-disabled')
        resolvedOptions.push(option)
        continue
      }
      const field = 'value' in spec ? 'value' : 'label'
      const wanted = 'value' in spec ? spec.value : spec.label
      let match: HTMLOptionElement | undefined
      for (const option of sel.options) {
        if (Date.now() >= deadline) return fail('page-timeout')
        if (option[field] !== wanted) continue
        if (match) return fail('option-ambiguous')
        match = option
      }
      if (!match) return fail('option-missing')
      if (optionUnavailable(match)) return fail('option-disabled')
      resolvedOptions.push(match)
    }

    let changed = false
    if (sel.multiple) {
      const wantedSet = new Set(resolvedOptions)
      for (const option of sel.options) {
        const nextSelected = wantedSet.has(option)
        if (option.selected !== nextSelected) {
          option.selected = nextSelected
          changed = true
        }
      }
    } else {
      const targetOption = resolvedOptions[0]
      if (!targetOption) return fail('option-missing')
      if (!targetOption.selected) {
        sel.selectedIndex = targetOption.index
        changed = true
      }
    }
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }))
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return ok(changed)
  }

  if (request.type === 'scrollPrep') {
    let container: Element | null = document.scrollingElement ?? document.documentElement
    let x = Math.round(innerWidth / 2)
    let y = Math.round(innerHeight / 2)
    if (request.target !== undefined) {
      const { item, error } = resolveSingle(request.target)
      if (error || !item) return fail(error ?? 'target-not-found')
      let cur: Element | null = item.element
      while (cur && !isScrollableElement(cur)) cur = cur.parentElement
      if (cur) container = cur
      const box = (cur ?? item.element).getBoundingClientRect()
      x = Math.round(item.offsetX + box.x + Math.min(box.width / 2, Math.max(10, box.width - 10)))
      y = Math.round(item.offsetY + box.y + Math.min(box.height / 2, Math.max(10, box.height - 10)))
    }
    if (request.to && container) {
      if (request.to === 'top') container.scrollTop = 0
      else container.scrollTop = container.scrollHeight - container.clientHeight
      return ok({
        x,
        y,
        scrollX: Math.round(container.scrollLeft),
        scrollY: Math.round(container.scrollTop),
        applied: true,
      })
    }
    return ok({
      x,
      y,
      scrollX: Math.round(container?.scrollLeft ?? scrollX),
      scrollY: Math.round(container?.scrollTop ?? scrollY),
      applied: false,
    })
  }

  if (request.type === 'scrollFallback') {
    let container: Element | null = document.scrollingElement ?? document.documentElement
    if (request.target !== undefined) {
      const { item } = resolveSingle(request.target)
      if (item) {
        let cur: Element | null = item.element
        while (cur && !isScrollableElement(cur)) cur = cur.parentElement
        if (cur) container = cur
      }
    }
    if (
      container === document.scrollingElement ||
      container === document.documentElement ||
      container === document.body
    ) {
      window.scrollBy(request.deltaX, request.deltaY)
      return ok({ x: Math.round(scrollX), y: Math.round(scrollY) })
    }
    if (container) {
      container.scrollBy(request.deltaX, request.deltaY)
      return ok({ x: Math.round(container.scrollLeft), y: Math.round(container.scrollTop) })
    }
    return ok({ x: Math.round(scrollX), y: Math.round(scrollY) })
  }

  return fail('page-timeout')
}

export async function runBrowserAgentPage<T extends BrowserPageRequest>(
  web: WebContents,
  documentId: number,
  url: string,
  deadline: number,
  request: T,
): Promise<BrowserPageResults[T['type']]> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new SystemReadError('timeout', '网页操作已过期')
  const args = [documentId, url, deadline, browserSnapshotLimits, request]
    .map((value) => JSON.stringify(value))
    .join(',')
  const code = `(${browserAgentPage.toString()})(${args})`
  const pageWrite = ['prepareInput', 'pasteDom', 'select', 'scrollPrep', 'scrollFallback'].includes(request.type)
  const uncertain = pageWrite ? ({ delivery: 'delivery_uncertain', retry: 'unsafe' } as const) : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response: PageResponse<BrowserPageResults[T['type']]> = await Promise.race([
      web.executeJavaScriptInIsolatedWorld(998, [{ code }]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SystemReadError('timeout', '网页未在截止时间前返回，请先读取页面状态', uncertain)),
          remaining,
        )
      }),
    ])
    if (response.ok) return response.result
    const [errorCode, message] = pageErrors[response.reason]
    throw new SystemReadError(errorCode, message, { reason: response.reason })
  } catch (cause) {
    if (cause instanceof SystemReadError) throw cause
    throw new SystemReadError('internal-error', '网页控件操作失败，请重新读取当前页面', uncertain)
  } finally {
    clearTimeout(timer)
  }
}
