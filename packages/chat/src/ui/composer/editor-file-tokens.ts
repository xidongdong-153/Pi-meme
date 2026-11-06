import { fileIconSprite, resolveFileIcon } from '@pi-meme/assets/file-icons'
import { fileReferences } from './completion-query'
import { fileReferenceClassName, fileReferenceDetails, fileReferenceIconClassName } from '../content/file-reference'

/** 文件引用仍保存为带引号的完整路径，编辑器只改变其显示。 */
export function fileReferenceNodes(text: string): Node[] {
  const nodes: Node[] = []
  let offset = 0
  for (const reference of fileReferences(text)) {
    if (reference.start > offset) nodes.push(document.createTextNode(text.slice(offset, reference.start)))
    const token = document.createElement('span')
    token.dataset.fileToken = reference.text
    token.setAttribute('contenteditable', 'false')
    const file = fileReferenceDetails(reference.path)
    token.setAttribute('aria-label', file.label)
    token.dataset.tooltip = reference.path
    token.className = `${fileReferenceClassName} select-none`
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('class', `pi-file-icon ${fileReferenceIconClassName}`)
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('focusable', 'false')
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `${fileIconSprite}#${resolveFileIcon(file.iconPath, file.directory)}`)
    icon.append(use)
    token.append(icon)
    token.append(document.createTextNode(file.name))
    nodes.push(token)
    offset = reference.end
  }
  if (offset < text.length) nodes.push(document.createTextNode(text.slice(offset)))
  return nodes
}
