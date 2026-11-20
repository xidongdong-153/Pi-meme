import { fileIconSprite, resolveFileIcon } from '@pi-meme/assets/file-icons'
import { composerReferences } from './completion-query'
import { fileReferenceClassName, fileReferenceDetails, fileReferenceIconClassName } from '../content/file-reference'

/** 文件引用仍保存为带引号的完整路径，编辑器只改变其显示。 */
export function fileReferenceNodes(text: string): Node[] {
  const nodes: Node[] = []
  let offset = 0
  for (const reference of composerReferences(text)) {
    if (reference.start > offset) nodes.push(document.createTextNode(text.slice(offset, reference.start)))
    const token = document.createElement('span')
    token.dataset.fileToken = reference.text
    token.setAttribute('contenteditable', 'false')
    if (reference.computer) {
      token.className = `${fileReferenceClassName} select-none`
      token.dataset.tooltip = '操作这台 Mac 上的应用'
      token.setAttribute('aria-label', '已选择电脑操控')
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('class', fileReferenceIconClassName)
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('width', '20')
      rect.setAttribute('height', '14')
      rect.setAttribute('x', '2')
      rect.setAttribute('y', '3')
      rect.setAttribute('rx', '2')
      const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line1.setAttribute('x1', '8')
      line1.setAttribute('x2', '16')
      line1.setAttribute('y1', '21')
      line1.setAttribute('y2', '21')
      const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line2.setAttribute('x1', '12')
      line2.setAttribute('x2', '12')
      line2.setAttribute('y1', '17')
      line2.setAttribute('y2', '21')
      svg.append(rect, line1, line2)
      token.append(svg, document.createTextNode('电脑'))
      nodes.push(token)
      offset = reference.end
      continue
    }
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
