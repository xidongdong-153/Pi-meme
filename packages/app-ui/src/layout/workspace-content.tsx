import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { Connection } from '@pi-meme/contracts/desktop'
import type { ChatState } from '@pi-meme/chat/ui/model/types'
import type { MessageEditorState } from '@pi-meme/chat/ui/conversation/inline-message-editor'
import { ErrorBoundary } from '@pi-meme/ui/components/error-boundary'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import { Button } from '@pi-meme/ui/components/ui/button'
import type { PiMessage } from '@pi-meme/contracts/pi'

export function WorkspaceContent({
  chat,
  connection,
  ready,
  hasConnected,
  switching = false,
  active = true,
  composer,
  conversation,
  onSettings,
  onSelectProject,
  projectSelectorOpen,
  notice,
  children,
}: {
  chat: ChatState
  connection: Connection
  ready: boolean
  hasConnected: boolean
  switching?: boolean
  active?: boolean
  composer: ReactNode
  conversation: ReactNode
  canEditMessages: boolean
  onEditMessage: (message: PiMessage) => void
  onForkReply: (timestamp: number) => void
  onCopyError: (message: string) => void
  onSettings: () => void
  onSelectProject?: (trigger?: HTMLElement) => void
  projectSelectorOpen?: boolean
  editor?: MessageEditorState
  notice: ReactNode
  children: ReactNode
}) {
  const hasConversation = chat.messages.length > 0 || chat.live !== null || chat.running
  const contentRef = useRef<HTMLDivElement>(null)
  const welcomeRef = useRef<HTMLDivElement>(null)
  const previousView = useRef({ sessionKey: connection.sessionKey, active })
  useLayoutEffect(() => {
    if (switching) return
    const previous = previousView.current
    previousView.current = { sessionKey: connection.sessionKey, active }
    if (
      !active ||
      !connection.sessionKey ||
      (previous.active && (!previous.sessionKey || previous.sessionKey === connection.sessionKey))
    )
      return

    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const reduced = () => {
      const preference = document.documentElement.dataset.reducedMotion
      return preference === undefined ? media?.matches : preference === 'true'
    }
    if (reduced()) return
    const content = contentRef.current
    if (!content?.animate) return
    const animations = [
      content.animate(
        [
          { opacity: 0, transform: hasConversation ? 'translateY(6px)' : 'none' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      ),
    ]
    const brand = welcomeRef.current?.querySelector('.brand-mark')
    if (brand) {
      animations.push(
        brand.animate([{ transform: 'translateY(4px) rotate(-5deg) scale(0.96)' }, { transform: 'none' }], {
          duration: 280,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }),
      )
    }
    const cancel = () => animations.forEach((animation) => animation.cancel())
    const onMotionChange = () => {
      if (reduced()) cancel()
    }
    media?.addEventListener('change', onMotionChange)
    const observer = new MutationObserver(onMotionChange)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    return () => {
      cancel()
      media?.removeEventListener('change', onMotionChange)
      observer.disconnect()
    }
  }, [connection.sessionKey, active, switching, hasConversation])
  const isStandalone = connection.workspaceKind === 'standalone' || !connection.cwd
  const projectName = (connection.sourceProjectCwd ?? connection.cwd).split(/[\\/]/).filter(Boolean).pop() || '当前项目'
  return (
    <section className="relative flex flex-1 min-h-0 min-w-0 flex-col bg-background" aria-label="工作区">
      {notice}
      <div className="relative flex flex-1 min-h-0 min-w-0 flex-col" aria-busy={switching}>
        <div
          ref={contentRef}
          className="session-content flex flex-1 min-h-0 min-w-0 flex-col"
          data-switching={switching || undefined}
          inert={switching}
          aria-hidden={switching || undefined}
        >
          {hasConversation ? (
            <ErrorBoundary inline fallbackTitle="当前会话内容渲染失败">
              {conversation}
            </ErrorBoundary>
          ) : !ready && (!hasConnected || connection.status === 'disconnected') ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6 min-h-0">
              {connection.status === 'connecting' ? (
                <div className="w-full max-w-sm text-center space-y-5 animate-in fade-in duration-300">
                  <BrandMark size={56} className="animate-pulse" />
                  <div className="space-y-1.5">
                    <h1 className="text-lg font-bold tracking-tight text-foreground">正在连接 Host</h1>
                    <p className="text-xs text-muted-foreground leading-relaxed">正在读取 Host 的会话快照。</p>
                  </div>
                  <div className="w-32 h-1 bg-secondary rounded-full mx-auto overflow-hidden">
                    <div className="h-full bg-primary/70 rounded-full animate-pulse w-full" />
                  </div>
                </div>
              ) : (
                <div className="w-full max-w-sm text-center space-y-4">
                  <BrandMark size={56} />
                  <div className="space-y-1.5">
                    <h1 className="text-lg font-bold tracking-tight text-foreground">Host 未连接</h1>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      检查 Host 是否正在运行，以及当前网络是否可访问 Host 地址。
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onSettings}
                    className="text-xs border-border cursor-pointer"
                  >
                    打开设置
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-6 min-h-0 overflow-y-auto">
              <div ref={welcomeRef} className="w-full max-w-2xl text-center space-y-6">
                <BrandMark size={56} className="mx-auto" />
                <div className="space-y-2">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                    {isStandalone ? (
                      '我们要构建什么？'
                    ) : (
                      <>
                        你想让我们在{' '}
                        {onSelectProject ? (
                          <button
                            type="button"
                            onClick={(event) => onSelectProject(event.currentTarget)}
                            data-state={projectSelectorOpen ? 'open' : 'closed'}
                            className="inline-flex items-center rounded-md px-1.5 py-0.5 -my-0.5 underline decoration-dotted underline-offset-8 decoration-muted-foreground/60 transition-colors hover:bg-secondary/70 hover:decoration-foreground/80 data-[state=open]:bg-secondary/70 data-[state=open]:decoration-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 cursor-pointer"
                            title="切换项目"
                            aria-label={`切换项目：当前为 ${projectName}`}
                            aria-expanded={projectSelectorOpen}
                          >
                            {projectName}
                          </button>
                        ) : (
                          <span className="underline decoration-dotted underline-offset-8 decoration-muted-foreground/60">
                            {projectName}
                          </span>
                        )}{' '}
                        中构建什么？
                      </>
                    )}
                  </h1>
                </div>

                <div className="pt-2 text-left">{composer}</div>
              </div>
            </div>
          )}
        </div>
        {switching && (
          <div
            role="status"
            className="session-loading pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3"
          >
            <BrandMark size={36} />
            <span className="text-xs text-muted-foreground">正在打开会话…</span>
          </div>
        )}
      </div>

      {/* 对话流底部的输入区 Dock */}
      {hasConversation && (
        <div className="chat-surface w-full pb-4 pt-1 shrink-0">
          <div className="chat-content-column">{composer}</div>
        </div>
      )}

      {children}
    </section>
  )
}
