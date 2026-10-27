import type { ReactNode } from 'react'
import { AlertCircle, LoaderCircle, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'

export type SideChatPanelProps = {
  /** 是否有对话（有对话时展示 conversation，无对话时展示空态） */
  hasConversation?: boolean
  /** 对话流渲染节点（Conversation） */
  conversation?: ReactNode
  /** 输入区渲染节点（Composer） */
  composer?: ReactNode
  /** 关闭失败时的错误信息 */
  closeError?: string
  /** 重试关闭回调 */
  onRetryClose?: () => void
  /** 是否正在关闭中 */
  closing?: boolean
  /** 额外的通知或状态横幅 */
  notice?: ReactNode
}

export function SideChatPanel({
  hasConversation = false,
  conversation,
  composer,
  closeError,
  onRetryClose,
  closing = false,
  notice,
}: SideChatPanelProps) {
  const showConversation = hasConversation && Boolean(conversation)

  return (
    <div
      role="region"
      aria-label="侧边临时聊天"
      className="side-chat-panel relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      {/* 错误提示横幅：例如关闭失败时提供明确原因与重试动作 */}
      {closeError && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="truncate">关闭失败：{closeError}</span>
          </div>
          {onRetryClose && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onRetryClose}
              className="h-6 shrink-0 gap-1 px-2 text-[11px] text-destructive hover:bg-destructive/20 hover:text-destructive"
            >
              <RefreshCw className="size-3" />
              重试
            </Button>
          )}
        </div>
      )}

      {notice && <div inert={closing || Boolean(closeError)}>{notice}</div>}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div inert={closing || Boolean(closeError)} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {showConversation ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{conversation}</div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center select-none">
              <div className="flex flex-col items-center max-w-xs space-y-3">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-secondary/60 text-muted-foreground">
                  <MessageSquarePlus className="size-6 text-foreground/70" aria-hidden="true" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">侧边聊天</h2>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    侧边聊天是临时聊天，关闭标签后会删除，不记录历史。
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 关闭中蒙层：禁止继续操作 */}
        {closing && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background/80 backdrop-blur-xs"
          >
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">正在关闭并清理临时聊天…</span>
          </div>
        )}
      </div>

      {/* 底部输入框 Dock：窄栏适配（宽度 >= 280px） */}
      {composer && (
        <div inert={closing || Boolean(closeError)} className="shrink-0 bg-background/95 p-2 backdrop-blur-xs">
          <div className="w-full max-w-full">{composer}</div>
        </div>
      )}
    </div>
  )
}
