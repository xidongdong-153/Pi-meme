import { fileExtensionIcons, fileNameIcons, folderNameIcons } from './file-icon-data'

export const fileIconSprite = new URL('../files/file-icons/catppuccin.svg', import.meta.url).href

const files = new Map(Object.entries(fileNameIcons))
const extensions = new Map(Object.entries(fileExtensionIcons))
const folders = new Map(Object.entries(folderNameIcons))

export function resolveFileIcon(path: string, directory = false, expanded = false) {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (directory) return `${folders.get(name) ?? '_folder'}${expanded ? '_open' : ''}`
  const exact = files.get(name)
  if (exact) return exact
  // 文件名优先，其次匹配最长扩展名，如 d.ts、test.tsx。
  let dot = name.indexOf('.')
  while (dot >= 0) {
    const icon = extensions.get(name.slice(dot + 1))
    if (icon) return icon
    dot = name.indexOf('.', dot + 1)
  }
  return '_file'
}
