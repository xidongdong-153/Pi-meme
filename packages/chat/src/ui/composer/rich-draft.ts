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
