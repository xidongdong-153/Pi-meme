import { readEditorText } from './rich-draft'

/** 插件位置只用于编辑器排版，不写入消息正文或持久化草稿。 */
export function movePluginPositions(positions: Map<string, number>, before: string, after: string) {
  if (before === after) return
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  for (const [id, offset] of positions)
    positions.set(id, offset <= start ? offset : offset >= oldEnd ? offset + newEnd - oldEnd : newEnd)
}

export function editorPluginPositions(editor: HTMLElement) {
  const positions = new Map<string, number>()
  for (const token of editor.querySelectorAll<HTMLElement>('[data-plugin-token]')) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEndBefore(token)
    positions.set(token.dataset.pluginToken!, readEditorText(range.cloneContents()).length)
  }
  return positions
}

export function adjacentPluginToken(editor: HTMLElement, backward: boolean): HTMLElement | undefined {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return
  let node: Node = selection.anchorNode
  const offset = selection.anchorOffset
  let inspect = false
  if (node.nodeType === Node.TEXT_NODE) {
    if (backward ? offset > 0 : offset < (node.textContent?.length ?? 0)) return
  } else {
    const child = node.childNodes[backward ? offset - 1 : offset]
    if (child) {
      node = child
      inspect = true
    }
  }
  while (node !== editor) {
    if (inspect) {
      if (node instanceof HTMLElement && node.dataset.pluginToken !== undefined) return node
      if (node instanceof HTMLElement && node.dataset.skillToken !== undefined) return
      if (node.nodeType === Node.TEXT_NODE && node.textContent) return
      // Chromium 在空的原子节点后补 BR；它与空文本节点都不阻挡退格定位。
      if (node.nodeName === 'BR' && node !== node.parentNode?.lastChild) return
      const child = backward ? node.lastChild : node.firstChild
      if (child) {
        node = child
        continue
      }
    }
    const sibling = backward ? node.previousSibling : node.nextSibling
    if (sibling) {
      node = sibling
      inspect = true
    } else {
      if (!node.parentNode) return
      node = node.parentNode
      inspect = false
    }
  }
}

export function createEditorToken(
  kind: 'skill' | 'plugin',
  id: string,
  name: string,
  title?: string,
  iconUrl?: string,
) {
  const token = document.createElement('span')
  token.dataset[kind === 'skill' ? 'skillToken' : 'pluginToken'] = id
  token.contentEditable = 'false'
  token.className =
    kind === 'plugin' ? 'inline-block mr-2 text-blue-400 select-none' : 'inline text-blue-400 select-none'
  token.setAttribute('aria-label', kind === 'skill' ? '已选择技能' : `插件：${name}`)
  token.title = title ?? id
  if (iconUrl) {
    const icon = document.createElement('img')
    icon.src = iconUrl
    icon.alt = ''
    icon.draggable = false
    icon.className = 'inline-block size-4 align-[-0.2em] mr-1'
    token.append(icon)
  } else {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.5')
    icon.setAttribute('class', 'inline-block size-4 align-[-0.2em] mr-1')
    icon.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M12 3 3 8v10l9 5 9-5V8L12 3Zm0 10 9-5M12 13 3 8m9 5v10M7.5 5.5l9 5')
    icon.append(path)
    token.append(icon)
  }
  token.append(document.createTextNode(name))
  return token
}
