import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import type { McpBridge, McpLogin } from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'

const statusMeta: Record<McpLogin['status'], { label: string; tone: string }> = {
  starting: { label: '正在联系授权服务…', tone: 'text-muted-foreground' },
  waiting: { label: '等待浏览器完成授权', tone: 'text-foreground' },
  checking: { label: '正在确认授权并检查连接…', tone: 'text-muted-foreground' },
  done: { label: '授权已保存', tone: 'text-emerald-600 dark:text-emerald-400' },
  failed: { label: '授权失败', tone: 'text-destructive' },
  cancelled: { label: '已取消授权', tone: 'text-muted-foreground' },
}

export function McpLoginPanel({ bridge, id, onFinished }: { bridge: McpBridge; id: string; onFinished: () => void }) {
  const [login, setLogin] = useState<McpLogin>({ id, status: 'starting' })
  const [error, setError] = useState('')
  const [redirect, setRedirect] = useState('')
  const [sending, setSending] = useState(false)
  const [retry, setRetry] = useState(0)
  const [showManual, setShowManual] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await bridge.getMcpLogin(id)
        if (!active) return
        setLogin(next)
        if (['starting', 'waiting', 'checking'].includes(next.status)) timer = setTimeout(() => void poll(), 650)
        else {
          setError('')
          setRedirect('')
          onFinished()
        }
      } catch (cause) {
        if (active) setError(String(cause))
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [bridge, id, retry, onFinished])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(setCopied, 1600, false)
    return () => clearTimeout(timer)
  }, [copied])

  const pending = ['starting', 'waiting', 'checking'].includes(login.status)
  const meta = statusMeta[login.status]

  const copyUrl = async () => {
    if (!login.url) return
    try {
      await navigator.clipboard.writeText(login.url)
      setCopied(true)
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-secondary/35 p-3.5 text-xs" aria-label="账号授权">
      <div className="flex items-center justify-between gap-2">
        <div role="status" className={cn('flex items-center gap-2 font-medium', meta.tone)}>
          {(login.status === 'starting' || login.status === 'checking') && (
            <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          )}
          {login.status === 'waiting' && (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
          )}
          {login.status === 'done' && <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />}
          {login.status === 'failed' && <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />}
          {login.status === 'cancelled' && <XCircle aria-hidden="true" className="size-3.5 shrink-0" />}
          <span>{meta.label}</span>
        </div>
        <div className="flex items-center gap-1">
          {error && pending && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setError('')
                setRetry((n) => n + 1)
              }}
            >
              <RefreshCw className="size-3" />
              刷新状态
            </Button>
          )}
          {['starting', 'waiting'].includes(login.status) && (
            <Button
              size="xs"
              variant="ghost"
              disabled={sending}
              onClick={async () => {
                try {
                  setLogin(await bridge.cancelMcpLogin(id))
                  setError('')
                  setRedirect('')
                  onFinished()
                } catch (cause) {
                  setError(String(cause))
                }
              }}
            >
              取消授权
            </Button>
          )}
        </div>
      </div>

      {login.status === 'waiting' && login.url && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={login.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              打开授权页面
            </a>
            <TooltipHint content={copied ? '已复制授权链接' : '复制授权链接'}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={settingsControlClassName}
                aria-label="复制授权链接"
                onClick={() => void copyUrl()}
              >
                {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                {copied ? '已复制' : '复制链接'}
              </Button>
            </TooltipHint>
          </div>

          <div className="border-t border-border/50 pt-2.5">
            <button
              type="button"
              aria-expanded={showManual}
              onClick={() => setShowManual((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn('size-3.5 transition-transform duration-150', showManual && 'rotate-180')}
              />
              浏览器无法自动返回？手动提交回调地址
            </button>
            {showManual && (
              <form
                className="mt-2.5 flex flex-wrap gap-2"
                onSubmit={async (event) => {
                  event.preventDefault()
                  if (sending) return
                  setSending(true)
                  setError('')
                  try {
                    await bridge.respondMcpLogin(id, redirect)
                    setRedirect('')
                  } catch (cause) {
                    setError(String(cause))
                  } finally {
                    setSending(false)
                  }
                }}
              >
                <Input
                  aria-label="完整回调地址"
                  placeholder="粘贴浏览器地址栏中的完整回调地址"
                  autoComplete="off"
                  className={cn(settingsControlClassName, 'min-w-44 flex-1 bg-background font-mono text-[11px]')}
                  value={redirect}
                  onChange={(event) => setRedirect(event.target.value)}
                />
                <Button type="submit" className={settingsControlClassName} disabled={sending || !redirect.trim()}>
                  {sending && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
                  提交回调
                </Button>
              </form>
            )}
          </div>
        </div>
      )}

      {(error || login.error) && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-2.5 py-2 text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 break-words">{error || login.error}</p>
        </div>
      )}
    </div>
  )
}
