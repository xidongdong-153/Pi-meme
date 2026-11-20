import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import type { ReactNode } from 'react'
import { Monitor } from 'lucide-react'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { composerReferences } from '../composer/completion-query'

export const fileReferenceClassName = 'inline rounded px-1 py-0.5 bg-blue-400/10 text-blue-400'
export const fileReferenceIconClassName = 'inline-block size-4 align-[-0.2em] mr-1'

export function fileReferenceDetails(path: string) {
  const directory = path.endsWith('/')
  const iconPath = path.replace(/\/$/, '')
  return {
    directory,
    iconPath,
    name: iconPath.split('/').at(-1)! + (directory ? '/' : ''),
    label: `${directory ? '已选择文件夹' : '已选择文件'}：${path}`,
  }
}

export function FileReferences({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let offset = 0
  for (const reference of composerReferences(text)) {
    if (reference.computer) {
      parts.push(
        text.slice(offset, reference.start),
        <TooltipHint key={reference.start} content="操作这台 Mac 上的应用">
          <span
            className="inline-flex items-center gap-1 rounded-md bg-white/15 px-1.5 py-0.5 text-[0.92em] font-medium text-white align-baseline"
            aria-label="电脑操控"
          >
            <Monitor aria-hidden="true" className="size-3.5 shrink-0 opacity-90" />
            电脑
          </span>
        </TooltipHint>,
      )
      offset = reference.end
      continue
    }
    const file = fileReferenceDetails(reference.path)
    parts.push(
      text.slice(offset, reference.start),
      <TooltipHint key={reference.start} content={reference.path}>
        <span className={fileReferenceClassName} aria-label={file.label}>
          <FileIcon path={file.iconPath} directory={file.directory} className={fileReferenceIconClassName} />
          {file.name}
        </span>
      </TooltipHint>,
    )
    offset = reference.end
  }
  parts.push(text.slice(offset))
  return parts
}
