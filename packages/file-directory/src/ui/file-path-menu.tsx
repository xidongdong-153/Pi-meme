import { useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@pi-meme/ui/components/ui/context-menu'

export type FilePathFormat = 'absolute' | 'relative'

export function absoluteFilePath(cwd: string, relativePath: string) {
  const separator = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd) ? '\\' : '/'
  const root = cwd.replaceAll('/', separator)
  return `${root}${root.endsWith(separator) ? '' : separator}${relativePath.replaceAll('/', separator)}`
}

export async function writePathToClipboard(path: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(path)
    return
  }

  // HTTP 下的浏览器可能只在原生 copy 事件中提供剪贴板。
  let copied = false
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', path)
    event.preventDefault()
    copied = true
  }
  document.addEventListener('copy', onCopy)
  try {
    if (!document.execCommand('copy') || !copied) throw new Error('剪贴板不可用')
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}

export function FileListPathMenu({
  children,
  onCopy,
  hasAbsolutePath,
}: {
  children: ReactNode
  onCopy: (path: string, format: FilePathFormat) => void
  hasAbsolutePath: boolean
}) {
  const [path, setPath] = useState<string>()
  function targetPath(target: EventTarget | null) {
    return target instanceof Element ? target.closest<HTMLElement>('[data-file-path]')?.dataset.filePath : undefined
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          const path = targetPath(event.target)
          setPath(path)
          if (!path) event.preventDefault()
        }}
        onPointerDown={(event) => {
          if (event.pointerType !== 'mouse') setPath(targetPath(event.target))
        }}
      >
        <div className="min-h-0 flex-1 overflow-auto py-1">{children}</div>
      </ContextMenuTrigger>
      {path && (
        <ContextMenuContent>
          <ContextMenuItem disabled={!hasAbsolutePath} onSelect={() => onCopy(path, 'absolute')}>
            <Copy />
            复制绝对路径
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopy(path, 'relative')}>复制相对路径</ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}
