import { useEffect, useRef, useState } from 'react'
import type { ModelsBridge } from '@pi-meme/contracts/desktop'
import type { BuiltinAuthType, BuiltinProviderInfo, ModelLoginState } from '@pi-meme/contracts/model-config'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@pi-meme/ui/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { ScrollArea } from '@pi-meme/ui/components/ui/scroll-area'
import { Search } from 'lucide-react'

type LoginBridge = Pick<
  ModelsBridge,
  | 'listBuiltinProviders'
  | 'startBuiltinLogin'
  | 'getBuiltinLogin'
  | 'respondBuiltinLogin'
  | 'cancelBuiltinLogin'
  | 'logoutBuiltinProvider'
  | 'reconnectModels'
>

function statusBadge(provider: BuiltinProviderInfo) {
  if (provider.subscription) {
    return (
      <Badge variant="success" className="h-5 px-1.5 text-[0.6875rem]">
        已登录订阅账号
      </Badge>
    )
  }
  if (provider.authType === 'oauth') {
    return (
      <Badge variant="success" className="h-5 px-1.5 text-[0.6875rem]">
        已登录
      </Badge>
    )
  }
  if (provider.configured) {
    return (
      <Badge variant="success" className="h-5 px-1.5 text-[0.6875rem]">
        已保存 API Key
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="h-5 px-1.5 text-[0.6875rem] text-muted-foreground">
      未登录
    </Badge>
  )
}

function methodLabel(provider: BuiltinProviderInfo, type: BuiltinAuthType) {
  const method = provider.methods.find((item) => item.type === type)
  if (type === 'api_key') return 'API Key'
  return method?.subscription ? '账号登录' : 'OAuth'
}

export function BuiltinProviders({ bridge, disabled }: { bridge: LoginBridge; disabled: boolean }) {
  const [providers, setProviders] = useState<BuiltinProviderInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [login, setLogin] = useState<ModelLoginState | null>(null)
  const [answer, setAnswer] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const active = useRef(true)
  async function load() {
    try {
      const next = await bridge.listBuiltinProviders()
      if (active.current) {
        setProviders(next)
        setError('')
      }
    } catch (cause) {
      if (active.current) setError(String(cause))
    }
  }
  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (!login || (login.status !== 'running' && login.status !== 'needs_input')) return
    let current = true
    const timer = setInterval(() => {
      void bridge
        .getBuiltinLogin()
        .then((next) => {
          if (!current || !next) return
          setLogin(next)
          if (next.status === 'done') void load()
        })
        .catch((cause: unknown) => {
          if (current) setError(String(cause))
        })
    }, 500)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [login?.id, login?.status])
  useEffect(() => {
    setAnswer('')
    setShowSecret(false)
  }, [login?.prompt?.id])
  async function begin(provider: BuiltinProviderInfo, authType: BuiltinAuthType) {
    setBusyId(provider.id)
    setError('')
    try {
      setLogin(await bridge.startBuiltinLogin({ providerId: provider.id, authType }))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusyId('')
    }
  }
  async function submit() {
    if (!login?.prompt || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const next = await bridge.respondBuiltinLogin({ id: login.id, promptId: login.prompt.id, value: answer })
      setLogin(next)
      if (next.status === 'done') await load()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSubmitting(false)
    }
  }
  async function closeLogin() {
    const current = login
    setLogin(null)
    if (!current || current.status === 'done' || current.status === 'cancelled' || current.status === 'error') return
    try {
      await bridge.cancelBuiltinLogin()
    } catch (cause) {
      setError(String(cause))
    }
  }
  async function logout(provider: BuiltinProviderInfo) {
    setBusyId(provider.id)
    setLogoutError('')
    try {
      const result = await bridge.logoutBuiltinProvider(provider.id)
      setProviders(result.providers)
      setLogoutError(result.reconnectError ?? '')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusyId('')
    }
  }
  const visible = (providers ?? []).filter((provider) =>
    `${provider.name} ${provider.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const prompt = login?.prompt
  const promptMessage =
    login?.authType === 'api_key' && prompt?.type === 'secret'
      ? `请输入 ${login.providerName} API Key`
      : prompt?.message
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border bg-card p-4">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base font-medium">内置服务商</CardTitle>
          </div>
          <div className="relative w-full sm:w-56">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
            />
            <Input
              aria-label="搜索内置服务商"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索服务商"
              className="h-9 rounded-lg bg-secondary/40 pl-8 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!providers && !error && (
            <p role="status" className="p-8 text-center text-sm text-muted-foreground">
              正在加载内置服务商…
            </p>
          )}
          {providers && (
            <ScrollArea className="h-96">
              <div className="divide-y divide-border">
                {visible.map((provider) => {
                  const interactive = provider.methods.some((method) => method.interactive)
                  return (
                    <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-medium">{provider.name}</h4>
                          <span className="font-mono text-xs text-muted-foreground">{provider.id}</span>
                          {statusBadge(provider)}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {provider.methods.map((method) => (
                            <Badge
                              key={method.type}
                              variant="secondary"
                              className="h-4.5 px-1.5 text-[0.625rem] font-normal text-muted-foreground"
                            >
                              {method.name}
                            </Badge>
                          ))}
                          {!interactive && <span className="text-xs text-muted-foreground">（不能在应用内登录）</span>}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {provider.methods
                          .filter((method) => method.interactive)
                          .map((method) => (
                            <Button
                              key={method.type}
                              size="sm"
                              variant="outline"
                              disabled={disabled || Boolean(busyId) || Boolean(login)}
                              onClick={() => void begin(provider, method.type)}
                            >
                              {busyId === provider.id ? '正在处理…' : methodLabel(provider, method.type)}
                            </Button>
                          ))}
                        {provider.configured && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled || Boolean(busyId) || Boolean(login)}
                            onClick={() => void logout(provider)}
                          >
                            退出登录
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {!visible.length && (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的服务商</p>
                )}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
      {logoutError && (
        <div role="alert" className="space-y-2 rounded-lg bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{logoutError}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void bridge
                .reconnectModels()
                .then(() => setLogoutError(''))
                .catch((cause: unknown) => setError(String(cause)))
            }
          >
            重新连接
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {login && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) void closeLogin()
          }}
        >
          <DialogContent aria-label={`${login.providerName} 登录`}>
            <DialogTitle>登录 {login.providerName}</DialogTitle>
            <DialogDescription>
              {login.authType === 'oauth' ? '按服务商页面完成账号登录。' : '输入服务商提供的 API Key。'}
            </DialogDescription>
            <div className="space-y-3">
              {login.notices.map((notice, index) => (
                <div key={`${notice.type}-${index}`} className="space-y-1 text-sm">
                  {notice.message && <p>{notice.message}</p>}
                  {notice.instructions && <p className="text-muted-foreground">{notice.instructions}</p>}
                  {notice.url && (
                    <a className="break-all text-primary underline" href={notice.url} target="_blank" rel="noreferrer">
                      {notice.url}
                    </a>
                  )}
                  {notice.verificationUri && (
                    <a
                      className="break-all text-primary underline"
                      href={notice.verificationUri}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {notice.verificationUri}
                    </a>
                  )}
                  {notice.userCode && (
                    <p className="font-mono">
                      设备码 {notice.userCode}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-2"
                        onClick={() => void navigator.clipboard?.writeText(notice.userCode ?? '')}
                      >
                        复制
                      </Button>
                    </p>
                  )}
                  {notice.links?.map((link) => (
                    <a
                      key={link.url}
                      className="block break-all text-primary underline"
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.label || link.url}
                    </a>
                  ))}
                </div>
              ))}
              {login.status === 'running' && !prompt && (
                <p role="status" className="text-sm text-muted-foreground">
                  正在等待服务商…
                </p>
              )}
              {prompt && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submit()
                  }}
                >
                  <p className="text-sm">{promptMessage}</p>
                  {prompt.type === 'select' ? (
                    <div className="space-y-2">
                      {prompt.options?.map((option) => (
                        <Button
                          key={option.id}
                          variant="outline"
                          className="h-auto w-full justify-start px-3 py-2 text-left"
                          disabled={submitting}
                          onClick={() => {
                            setAnswer(option.id)
                            setSubmitting(true)
                            void bridge
                              .respondBuiltinLogin({ id: login.id, promptId: prompt.id, value: option.id })
                              .then((next) => {
                                setLogin(next)
                                if (next.status === 'done') return load()
                              })
                              .catch((cause: unknown) => setError(String(cause)))
                              .finally(() => setSubmitting(false))
                          }}
                        >
                          <span>
                            {option.label}
                            {option.description && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                            )}
                          </span>
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Input
                        aria-label={promptMessage}
                        autoFocus
                        type={prompt.type === 'secret' && !showSecret ? 'password' : 'text'}
                        autoComplete="off"
                        value={answer}
                        placeholder={
                          login.authType === 'api_key' && prompt.type === 'secret' ? promptMessage : prompt.placeholder
                        }
                        onChange={(event) => setAnswer(event.target.value)}
                      />
                      {prompt.type === 'secret' && (
                        <Button variant="outline" onClick={() => setShowSecret((value) => !value)}>
                          {showSecret ? '隐藏' : '显示'}
                        </Button>
                      )}
                      <Button type="submit" disabled={submitting || !answer.trim()}>
                        {submitting ? '正在提交…' : '继续'}
                      </Button>
                    </div>
                  )}
                </form>
              )}
              {login.error && login.status !== 'needs_input' && (
                <p className="text-sm text-destructive">{login.error}</p>
              )}
              {login.reconnectError && (
                <div role="alert" className="space-y-2">
                  <p className="text-sm text-destructive">{login.reconnectError}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void bridge
                        .reconnectModels()
                        .then(() => setLogin((current) => current && { ...current, reconnectError: undefined }))
                        .catch((cause: unknown) => setError(String(cause)))
                    }
                  >
                    重新连接
                  </Button>
                </div>
              )}
              {login.status === 'done' && !login.reconnectError && (
                <p role="status" className="text-sm text-muted-foreground">
                  登录已保存。
                </p>
              )}
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void closeLogin()}>
                  {login.status === 'running' || login.status === 'needs_input' ? '取消' : '关闭'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
