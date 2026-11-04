import type { ReactNode } from 'react'
import { FileIcon } from '@pi-meme/ui/components/file-icon'
import { fileReferences } from '../composer/completion-query'

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
  for (const reference of fileReferences(text)) {
    const file = fileReferenceDetails(reference.path)
    parts.push(
      text.slice(offset, reference.start),
      <span key={reference.start} title={reference.path} className={fileReferenceClassName} aria-label={file.label}>
        <FileIcon path={file.iconPath} directory={file.directory} className={fileReferenceIconClassName} />
        {file.name}
      </span>,
    )
    offset = reference.end
  }
  parts.push(text.slice(offset))
  return parts
}
