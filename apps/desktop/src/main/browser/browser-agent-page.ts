import type { WebContents } from 'electron'
import {
  browserSnapshotLimits,
  type BrowserAgentElement,
  type BrowserAgentPageSnapshot,
  type BrowserDomCondition,
  type BrowserSelectOption,
} from '@pi-meme/contracts/browser-agent'
import { SystemReadError, type ReadErrorCode } from '@pi-meme/contracts/system-read'

type BrowserPageRequest =
  | { type: 'read'; prefix: string }
  | { type: 'probe'; condition: BrowserDomCondition }
  | { type: 'scroll'; delta: number }
  | { type: 'click' | 'focus'; elementId: string }
  | { type: 'input'; elementId: string; text: string }
  | { type: 'select'; elementId: string; option: BrowserSelectOption }
type BrowserPageResults = {
  read: BrowserAgentPageSnapshot
  probe: boolean
  scroll: null
  click: null
  focus: null
  input: null
  select: boolean
}

const pageErrors = {
  'stale-document': ['stale-cursor', '网页文档已变化，请重新调用 browser.read'],
  'stale-element': ['stale-cursor', '网页控件已变化，请重新调用 browser.read'],
  'element-disabled': ['disabled', '网页控件已禁用或位于不可操作的区域'],
  'element-unfocusable': ['disabled', '无法将键盘焦点置于指定控件'],
  'not-editable': ['invalid-input', '指定控件不可填写'],
  'not-clickable': ['invalid-input', '指定控件不可点击'],
  'not-single-select': ['invalid-input', '请选择原生单选下拉控件'],
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

  type Reference = { id: string; element: Element; identity: string }
  const isolated = globalThis as typeof globalThis & {
    piAgentPage?: { documentId: number; url: string; references: Map<string, Reference> }
  }
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
  const state = isolated.piAgentPage
  const isCurrent = state?.documentId === documentId && state.url === url
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
  const candidates = 'a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable]'
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
    if (element instanceof HTMLInputElement) {
      switch (element.type) {
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
          return element.list ? 'combobox' : 'searchbox'
        default:
          return element.list ? 'combobox' : 'textbox'
      }
    }
    if (element instanceof HTMLSelectElement) return element.multiple || element.size > 1 ? 'listbox' : 'combobox'
    if (element.matches('a[href]')) return 'link'
    if (element instanceof HTMLElement && element.isContentEditable) return 'textbox'
    return Object.hasOwn(nativeRoles, element.localName) ? nativeRoles[element.localName] : null
  }

  function renderedText(element: HTMLElement) {
    // Layout-aware text preserves line breaks and omits content with display or visibility disabled.
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content
    return element.innerText
  }

  function labelText(label: HTMLLabelElement, control: Element) {
    if (!label.contains(control)) return renderedText(label)
    // The text of a wrapping label excludes its own control (including its select options).
    const range = document.createRange()
    range.selectNodeContents(label)
    range.setEndBefore(control)
    const before = range.toString()
    range.selectNodeContents(label)
    range.setStartAfter(control)
    return `${before} ${range.toString()}`
  }

  function nameFor(element: Element, role: string | null): string {
    const labelledBy = element.getAttribute('aria-labelledby')?.trim()
    if (labelledBy) {
      const text = normalize(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      )
      if (text) return text.slice(0, 300)
    }
    const ariaLabel = normalize(element.getAttribute('aria-label') ?? '')
    if (ariaLabel) return ariaLabel.slice(0, 300)
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLButtonElement
    ) {
      const labels = normalize(Array.from(element.labels ?? [], (label) => labelText(label, element)).join(' '))
      if (labels) return labels.slice(0, 300)
    }
    const alt = element.getAttribute('alt') ?? element.querySelector('img[alt]')?.getAttribute('alt') ?? ''
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type))
      return normalize(element.value || alt || element.title).slice(0, 300)
    const fromContent =
      role !== 'textbox' &&
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      )
    const content = fromContent ? (element instanceof HTMLElement ? renderedText(element) : element.textContent) : ''
    return normalize(
      content || alt || element.getAttribute('title') || element.getAttribute('placeholder') || '',
    ).slice(0, 300)
  }

  function identityOf(element: Element, role: string | null, name: string) {
    const form =
      element instanceof HTMLInputElement ||
      element instanceof HTMLButtonElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? element.form
        : null
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

  function readValue(element: Element, name: string) {
    if (element instanceof HTMLInputElement) {
      if (['password', 'file', 'hidden'].includes(element.type)) return undefined
      if (/\b(?:one-time-code|current-password|new-password|cc-number|cc-csc)\b/i.test(element.autocomplete))
        return undefined
      const labels = `${name} ${element.name} ${element.id}`.replace(/[_-]/g, ' ')
      if (/\b(?:password|passcode|otp|2fa|verification *code|one *time *(?:password|code))\b|密码|验证码/i.test(labels))
        return undefined
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLButtonElement
    )
      return element.value.slice(0, 1024)
    return undefined
  }

  function ariaState(element: Element, attribute: string) {
    const value = element.getAttribute(attribute)
    return value === 'true' ? true : value === 'false' ? false : undefined
  }

  function visibleTextMatches(body: HTMLElement, needle: string): boolean | undefined {
    if (!normalize(renderedText(body)).includes(needle)) return false
    // innerText may still include fully transparent text. Use the rendered text nodes to confirm the match.
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
    return normalize(chunks.join('')).includes(needle)
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
    const role = condition.role
    const name = normalize(condition.name)
    for (const element of document.querySelectorAll(`${candidates},${Object.keys(nativeRoles).join(',')}`)) {
      if (Date.now() >= deadline) return fail('page-timeout')
      if (roleFor(element) === role && visible(element) && nameFor(element, role) === name)
        return ok(condition.state === 'visible')
    }
    return ok(condition.state === 'hidden')
  }

  if (request.type === 'read') {
    const references = isCurrent ? state.references : new Map<string, Reference>()
    const previous = new Map<Element, Reference>()
    for (const reference of references.values()) {
      if (reference.element.isConnected) previous.set(reference.element, reference)
      else references.delete(reference.id)
    }
    const elements: BrowserAgentElement[] = []
    let truncatedElements = false
    let remainingOptions = limits.options
    for (const element of document.querySelectorAll(candidates)) {
      if (Date.now() >= deadline) return fail('page-timeout')
      if (element instanceof HTMLInputElement && element.type === 'hidden') continue
      const role = roleFor(element)
      if (
        !element.matches('a,button,input,textarea,select,summary,[tabindex]') &&
        !(element instanceof HTMLElement && element.isContentEditable) &&
        !(role && interactiveRoles.has(role))
      )
        continue
      if (!visible(element)) continue
      if (elements.length === limits.elements) {
        truncatedElements = true
        break
      }
      const name = nameFor(element, role)
      const identity = identityOf(element, role, name)
      const oldReference = previous.get(element)
      const id = oldReference?.identity === identity ? oldReference.id : `${request.prefix}:${elements.length}`
      if (oldReference) references.delete(oldReference.id)
      references.set(id, { id, element, identity })
      const item: BrowserAgentElement = {
        id,
        tag: element.localName.slice(0, 128),
        role,
        name,
        type: element.getAttribute('type')?.slice(0, 64) ?? null,
        value: readValue(element, name),
        disabled: disabled(element),
        readOnly: readOnly(element),
        checked:
          element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
            ? element.indeterminate
              ? 'mixed'
              : element.checked
            : element.getAttribute('aria-checked') === 'mixed'
              ? 'mixed'
              : ariaState(element, 'aria-checked'),
        selected: ariaState(element, 'aria-selected'),
        expanded: ariaState(element, 'aria-expanded'),
      }
      if (element instanceof HTMLSelectElement) {
        const count = Math.min(element.options.length, remainingOptions, limits.optionsPerElement)
        item.options = []
        item.optionsTruncated = count < element.options.length
        for (let index = 0; index < count; index++) {
          const option = element.options[index]
          const label = option.label.slice(0, 300)
          const value = option.value.length <= 1024 ? option.value : undefined
          item.optionsTruncated ||= option.label !== label || value === undefined
          item.options.push({ label, value, selected: option.selected, disabled: optionUnavailable(option) })
        }
        remainingOptions -= count
      }
      elements.push(item)
    }
    while (references.size > limits.elements * 3) {
      const oldest = references.keys().next().value
      if (oldest === undefined) break
      references.delete(oldest)
    }
    isolated.piAgentPage = { documentId, url, references }
    const text = document.body ? renderedText(document.body) : ''
    return ok({
      title: document.title.slice(0, 512),
      text: text.slice(0, limits.text),
      elements,
      truncated: { text: text.length > limits.text, elements: truncatedElements },
    })
  }

  if (request.type === 'scroll') {
    window.scrollBy(0, request.delta)
    return ok(null)
  }
  if (!isCurrent) return fail('stale-element')
  const reference = state.references.get(request.elementId)
  if (!reference) return fail('stale-element')
  const { element } = reference
  if (!element.isConnected || !visible(element)) return fail('stale-element')
  const role = roleFor(element)
  if (identityOf(element, role, nameFor(element, role)) !== reference.identity) return fail('stale-element')
  if (disabled(element)) return fail('element-disabled')
  if (Date.now() >= deadline) return fail('page-timeout')
  if (request.type === 'focus') {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return fail('element-unfocusable')
    if (document.activeElement !== element) element.focus({ preventScroll: true })
    if (location.href !== url) return fail('stale-document')
    if (!element.isConnected || document.activeElement !== element || !document.hasFocus())
      return fail('element-unfocusable')
    if (disabled(element)) return fail('element-disabled')
    return ok(null)
  }
  if (request.type === 'click') {
    if (!(element instanceof HTMLElement)) return fail('not-clickable')
    element.click()
    return ok(null)
  }
  if (request.type === 'select') {
    if (!(element instanceof HTMLSelectElement) || element.multiple) return fail('not-single-select')
    if (readOnly(element)) return fail('not-editable')
    const field = 'value' in request.option ? 'value' : 'label'
    const selection = 'value' in request.option ? request.option.value : request.option.label
    let match: HTMLOptionElement | undefined
    for (const option of element.options) {
      if (Date.now() >= deadline) return fail('page-timeout')
      if (option[field] !== selection) continue
      if (match) return fail('option-ambiguous')
      match = option
    }
    if (!match) return fail('option-missing')
    if (optionUnavailable(match)) return fail('option-disabled')
    if (match.selected) return ok(false)
    if (Date.now() >= deadline) return fail('page-timeout')
    element.selectedIndex = match.index
  } else if (request.type === 'input') {
    if (readOnly(element)) return fail('not-editable')
    if (element instanceof HTMLElement && element.isContentEditable) element.textContent = request.text
    else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
      element.value = request.text
    else if (element instanceof HTMLInputElement && !['file', 'hidden'].includes(element.type))
      element.value = request.text
    else return fail('not-editable')
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return ok(request.type === 'select' ? true : null)
}

export async function runBrowserAgentPage<T extends BrowserPageRequest>(
  web: WebContents,
  documentId: number,
  url: string,
  deadline: number,
  request: T,
): Promise<BrowserPageResults[T['type']]> {
  // A queued Electron evaluation can start after its caller timed out. Check the same deadline in the guest.
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new SystemReadError('timeout', '网页操作已过期')
  const args = [documentId, url, deadline, browserSnapshotLimits, request]
    .map((value) => JSON.stringify(value))
    .join(',')
  const code = `(${browserAgentPage.toString()})(${args})`
  const pageWrite = ['click', 'input', 'select', 'scroll'].includes(request.type)
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
