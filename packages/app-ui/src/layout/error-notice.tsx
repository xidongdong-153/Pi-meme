import type { ReactNode } from 'react'
import { classifySystemError, SystemErrorCard } from '@pi-meme/ui/components/system-error-card'

const toastCard =
  'pointer-events-auto w-full min-w-[240px] max-w-md animate-in slide-in-from-right-4 shadow-lg backdrop-blur-xs'

export function SystemErrorToast({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed top-16 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {children}
    </div>
  )
}

export function ErrorNotice({
  message,
  onOpenSettings,
  onDismiss,
  extension = false,
  toast = true,
}: {
  message: string
  onOpenSettings: () => void
  onDismiss: () => void
  extension?: boolean
  toast?: boolean
}) {
  const copy = classifySystemError(message, extension)
  if (!copy.text) return null
  const card = (
    <SystemErrorCard
      title={copy.title}
      body={copy.body}
      detail={copy.text}
      live={copy.live}
      onOpenSettings={copy.settings ? onOpenSettings : undefined}
      onDismiss={onDismiss}
      className={toastCard}
    />
  )
  return toast ? <SystemErrorToast>{card}</SystemErrorToast> : card
}

export function SystemErrorStack({
  items,
  contained = false,
}: {
  items: Array<{
    id: string
    message: string
    extension?: boolean
    onOpenSettings: () => void
    onDismiss: () => void
  }>
  contained?: boolean
}) {
  const visible = items.filter((item) => item.message.trim()).slice(0, 2)
  if (!visible.length) return null
  const cards = visible.map((item) => (
    <ErrorNotice
      key={item.id}
      toast={false}
      message={item.message}
      extension={item.extension}
      onOpenSettings={item.onOpenSettings}
      onDismiss={item.onDismiss}
    />
  ))
  return contained ? cards : <SystemErrorToast>{cards}</SystemErrorToast>
}
