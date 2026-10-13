import type { ReactNode } from 'react'
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
  composer,
  conversation,
  onSettings,
  notice,
  children,
}: {
  chat: ChatState
  connection: Connection
  ready: boolean
  hasConnected: boolean
  composer: ReactNode
  conversation: ReactNode
  canEditMessages: boolean
  onEditMessage: (message: PiMessage) => void
  onSwitchMessageVersion: (timestamp: number, version: number) => void
  onForkReply: (timestamp: number) => void
  onCopyError: (message: string) => void
  onSettings: () => void
  editor?: MessageEditorState
  switchingVersion?: number
  notice: ReactNode
  children: ReactNode
}) {
  const hasConversation = chat.messages.length > 0 || chat.live !== null || chat.running
  return (
    <section className="relative flex flex-1 min-h-0 min-w-0 flex-col bg-background" aria-label="工作区">
      {notice}
      {hasConversation ? (
        <ErrorBoundary fallbackTitle="当前会话内容渲染失败，可尝试切换其他会话">{conversation}</ErrorBoundary>
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
              <Button variant="outline" size="sm" onClick={onSettings} className="text-xs border-border cursor-pointer">
                打开设置
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center p-6 min-h-0 overflow-y-auto">
          <div className="w-full max-w-2xl text-center space-y-6">
            <BrandMark size={56} />
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">开始一个新任务</h1>
              <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                选择项目目录，向 Pi 描述你的编码任务、Bug 修复或需求构想。
              </p>
            </div>

            <div className="pt-2 text-left">{composer}</div>
          </div>
        </div>
      )}

      {/* 对话流底部的输入区 Dock */}
      {hasConversation && <div className="w-full max-w-3xl mx-auto px-4 pb-4 pt-1 shrink-0">{composer}</div>}

      {children}
    </section>
  )
}
