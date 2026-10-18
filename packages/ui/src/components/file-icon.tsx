import { fileIconSprite, resolveFileIcon } from '@pi-meme/assets/file-icons'
import { cn } from '../lib/utils'

export function FileIcon({
  path,
  directory = false,
  expanded = false,
  className,
}: {
  path: string
  directory?: boolean
  expanded?: boolean
  className?: string
}) {
  return (
    <svg
      className={cn('pi-file-icon size-4 shrink-0', className)}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`${fileIconSprite}#${resolveFileIcon(path, directory, expanded)}`} />
    </svg>
  )
}
