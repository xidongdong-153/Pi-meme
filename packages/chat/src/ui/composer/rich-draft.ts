import { skillMarker } from '@pi-meme/contracts/skills'

export function readEditorText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof HTMLElement && node.dataset.pluginToken !== undefined) return ''
  if (node instanceof HTMLElement && node.dataset.skillToken !== undefined) return skillMarker
  if (node.nodeName === 'BR') return '\n'
  let text = ''
  for (const child of node.childNodes) {
    if (child.nodeName === 'BR' && child === node.lastChild && node instanceof HTMLElement) continue
    if ((child.nodeName === 'DIV' || child.nodeName === 'P') && text && !text.endsWith('\n')) text += '\n'
    text += readEditorText(child)
  }
  return text
}

function logicalEditorText(node: Node): string {
  if (node instanceof HTMLElement && (node.dataset.pluginToken !== undefined || node.dataset.skillToken !== undefined))
    return skillMarker
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeName === 'BR') return '\n'
  let text = ''
  for (const child of node.childNodes) {
    if (child.nodeName === 'BR' && child === node.lastChild && node instanceof HTMLElement) continue
    if ((child.nodeName === 'DIV' || child.nodeName === 'P') && text && !text.endsWith('\n')) text += '\n'
    text += logicalEditorText(child)
  }
  return text
}

export function editorSelection(editor: HTMLElement): { anchor: number; focus: number } | null {
  const selection = window.getSelection()
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !editor.contains(selection.anchorNode) ||
    !editor.contains(selection.focusNode)
  )
    return null
  const offset = (node: Node, end: number) => {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(node, end)
    return logicalEditorText(range.cloneContents()).length
  }
  return {
    anchor: offset(selection.anchorNode, selection.anchorOffset),
    focus: offset(selection.focusNode, selection.focusOffset),
  }
}

export function setEditorSelection(editor: HTMLElement, input: { anchor: number; focus: number }) {
  const position = (offset: number): [Node, number] => {
    let cursor = 0
    const visit = (parent: Node): [Node, number] | undefined => {
      let text = ''
      for (let index = 0; index < parent.childNodes.length; index++) {
        const node = parent.childNodes[index]
        if (node.nodeName === 'BR' && node === parent.lastChild && parent instanceof HTMLElement) continue
        if ((node.nodeName === 'DIV' || node.nodeName === 'P') && text && !text.endsWith('\n')) {
          if (offset <= cursor) return [parent, index]
          text += '\n'
          cursor++
        }
        const value = logicalEditorText(node)
        if (node.nodeType === Node.TEXT_NODE) {
          if (offset <= cursor + value.length) return [node, Math.max(0, offset - cursor)]
          cursor += value.length
        } else if (
          (node instanceof HTMLElement &&
            (node.dataset.pluginToken !== undefined || node.dataset.skillToken !== undefined)) ||
          node.nodeName === 'BR'
        ) {
          if (offset <= cursor + value.length) return [parent, index + (offset > cursor ? 1 : 0)]
          cursor += value.length
        } else {
          const found = visit(node)
          if (found) return found
        }
        text += value
      }
      return undefined
    }
    return visit(editor) ?? [editor, editor.childNodes.length]
  }
  const [anchor, anchorOffset] = position(input.anchor)
  const [focus, focusOffset] = position(input.focus)
  window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
}

export function editorCaret(editor: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return readEditorText(editor).length
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset)
  return readEditorText(range.cloneContents()).length
}

export function setEditorCaret(editor: HTMLElement, offset: number) {
  const range = document.createRange()
  let remaining = offset
  for (const node of editor.childNodes) {
    const length = readEditorText(node).length
    if (node instanceof HTMLElement && node.dataset.pluginToken !== undefined) continue
    if (
      remaining === length &&
      node.nextSibling instanceof HTMLElement &&
      node.nextSibling.dataset.pluginToken !== undefined
    ) {
      remaining = 0
      continue
    }
    if (remaining <= length) {
      if (node.nodeType === Node.TEXT_NODE) range.setStart(node, remaining)
      else if (remaining === 0) range.setStartBefore(node)
      else range.setStartAfter(node)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= length
  }
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
