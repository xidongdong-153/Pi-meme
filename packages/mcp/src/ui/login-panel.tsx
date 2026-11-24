import { useEffect, useState } from 'react'
import type { McpBridge, McpLogin } from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'

export function McpLoginPanel({ bridge, id, onFinished }: { bridge: McpBridge; id: string; onFinished: () => void }) {
  const [login, setLogin] = useState<McpLogin>({ id, status: 'starting' })
  const [error, setError] = useState('')
  const [redirect, setRedirect] = useState('')
  const [sending, setSending] = useState(false)
  const [retry, setRetry] = useState(0)
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
  const pending = ['starting', 'waiting', 'checking'].includes(login.status)
  return (
    <div className="space-y-3 text-xs" aria-label="账号授权">
      <p role="status">
        {
          {
            starting: '正在联系授权服务…',
            waiting: '等待浏览器授权',
            checking: '正在确认授权并检查连接…',
            done: '授权已保存',
            failed: '授权失败',
            cancelled: '已取消授权',
          }[login.status]
        }
      </p>
      {login.status === 'waiting' && login.url && (
        <>
          <a
            href={login.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground"
          >
            打开授权页面
          </a>
          <details className="space-y-2">
            <summary className="cursor-pointer text-muted-foreground">浏览器无法自动返回？</summary>
            <form
              className="flex flex-wrap gap-2"
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
                className="min-w-40 flex-1"
                value={redirect}
                onChange={(event) => setRedirect(event.target.value)}
              />
              <Button type="submit" className={settingsControlClassName} disabled={sending || !redirect.trim()}>
                提交回调
              </Button>
            </form>
          </details>
        </>
      )}
      {(error || login.error) && (
        <p role="alert" className="break-words text-destructive">
          {error || login.error}
        </p>
      )}
      <div className="flex gap-2">
        {['starting', 'waiting'].includes(login.status) && (
          <Button
            size="sm"
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
        {error && pending && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError('')
              setRetry((n) => n + 1)
            }}
          >
            刷新状态
          </Button>
        )}
      </div>
    </div>
  )
}
