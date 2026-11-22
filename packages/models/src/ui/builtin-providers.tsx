import { useEffect, useRef, useState } from 'react'
import type { ModelsBridge } from '@pi-meme/contracts/desktop'
import type { BuiltinAuthType, BuiltinProviderInfo, ModelLoginState } from '@pi-meme/contracts/model-config'
import { Badge } from '@pi-meme/ui/components/ui/badge'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { TooltipHint, TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Eye, EyeOff, LogOut, Search } from 'lucide-react'
import { cn } from '@pi-meme/ui/lib/utils'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { RevealContent } from '@pi-meme/ui/components/reveal-content'

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
      <Badge variant="success" className="h-5 whitespace-nowrap px-1.5 text-[0.6875rem]">
        <CrossfadeText>已登录订阅</CrossfadeText>
      </Badge>
    )
  }
  if (provider.authType === 'oauth') {
    return (
      <Badge variant="success" className="h-5 whitespace-nowrap px-1.5 text-[0.6875rem]">
        <CrossfadeText>已登录</CrossfadeText>
      </Badge>
    )
  }
  if (provider.configured) {
    return (
      <Badge variant="success" className="h-5 whitespace-nowrap px-1.5 text-[0.6875rem]">
        <CrossfadeText>已配 Key</CrossfadeText>
      </Badge>
    )
  }
  return null
}

function methodLabel(provider: BuiltinProviderInfo, type: BuiltinAuthType) {
  const method = provider.methods.find((item) => item.type === type)
  if (type === 'api_key') return provider.configured ? '更新 Key' : '配置 Key'
  if (provider.configured) return method?.subscription ? '重新登录' : '重连 OAuth'
  return method?.subscription ? '账号登录' : 'OAuth 登录'
}

export function BuiltinProviders({ bridge, disabled }: { bridge: LoginBridge; disabled: boolean }) {
  const [providers, setProviders] = useState<BuiltinProviderInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'connected'>('all')
  const [loading, setLoading] = useState(true)
  const loadingRef = useRef(false)
  const [error, setError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [login, setLogin] = useState<ModelLoginState | null>(null)
  const [answer, setAnswer] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const active = useRef(true)

  async function load() {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const next = await bridge.listBuiltinProviders()
      if (active.current) {
        setProviders(next)
        setError('')
      }
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      loadingRef.current = false
      if (active.current) setLoading(false)
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

  const allProviders = providers ?? []
  const connectedCount = allProviders.filter((provider) => provider.configured).length
  const search = query.trim().toLowerCase()
  const matched = allProviders.filter((provider) => {
    if (filter === 'connected' && !provider.configured) return false
    if (!search) return true
    return `${provider.name} ${provider.id}`.toLowerCase().includes(search)
  })
  const connectedList = matched.filter((provider) => provider.configured)
  const unconnectedList = matched.filter((provider) => !provider.configured)

  const prompt = login?.prompt
  const promptMessage =
    login?.authType === 'api_key' && prompt?.type === 'secret'
      ? `请输入 ${login.providerName} API Key`
      : prompt?.message

  const renderProviderRow = (provider: BuiltinProviderInfo) => {
    const interactiveMethods = provider.methods.filter((method) => method.interactive)
    return (
      <SettingsRow key={provider.id} className="gap-y-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn('size-2 shrink-0 rounded-full', provider.configured ? 'bg-emerald-500' : 'bg-border')}
          />
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h4 className="whitespace-nowrap text-xs font-medium">{provider.name}</h4>
              <span className="truncate font-mono text-[11px] text-muted-foreground">{provider.id}</span>
              {statusBadge(provider)}
            </div>
            {!interactiveMethods.length && (
              <p className="text-[11px] text-muted-foreground">仅支持通过环境变量或外部配置</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-1.5">
          {interactiveMethods.map((method) => (
            <Button
              className={cn(settingsControlClassName, 'whitespace-nowrap')}
              key={method.type}
              size="sm"
              variant={provider.configured ? 'ghost' : 'outline'}
              disabled={disabled || Boolean(busyId) || Boolean(login)}
              onClick={() => void begin(provider, method.type)}
            >
              {busyId === provider.id ? '处理中…' : methodLabel(provider, method.type)}
            </Button>
          ))}
          {provider.configured && (
            <TooltipHint content="退出登录">
              <Button
                className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                size="icon"
                variant="ghost"
                aria-label={`退出 ${provider.name}`}
                disabled={disabled || Boolean(busyId) || Boolean(login)}
                onClick={() => void logout(provider)}
              >
                <LogOut className="size-3.5" />
              </Button>
            </TooltipHint>
          )}
        </div>
      </SettingsRow>
    )
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4" aria-busy={loading}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="搜索内置服务商"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索内置服务商"
              className="h-8 max-w-full rounded-lg bg-secondary/40 pl-8 text-xs shadow-none"
            />
          </div>
          <div
            role="group"
            aria-label="筛选服务商状态"
            className="inline-flex shrink-0 gap-1 rounded-lg bg-secondary/50 p-0.5"
          >
            {(
              [
                { id: 'all', label: '全部', count: allProviders.length },
                { id: 'connected', label: '已连接', count: connectedCount },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={cn(
                  'whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  filter === item.id
                    ? 'bg-card font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
                {providers !== null && <span className="ml-1 text-[10px] opacity-70 tabular-nums">{item.count}</span>}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 p-3"
          >
            <p className="text-xs text-destructive">{error}</p>
            <Button
              className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load()}
            >
              重试读取
            </Button>
          </div>
        )}

        {logoutError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 p-3"
          >
            <p className="text-xs text-destructive">{logoutError}</p>
            <Button
              className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
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

        {loading && !providers && (
          <p role="status" className="px-1 text-[11px] text-muted-foreground">
            正在读取内置服务商…
          </p>
        )}

        <RevealContent ready={providers !== null}>
          {providers && (
            <div className="space-y-4">
              {!matched.length ? (
                <SettingsCard>
                  <div className="px-4 py-8 text-center text-[11px] text-muted-foreground">
                    {filter === 'connected' && !search
                      ? '尚未连接内置服务商，可切换至“全部”进行登录或配置 API Key。'
                      : '没有匹配的内置服务商'}
                  </div>
                </SettingsCard>
              ) : (
                <>
                  {connectedList.length > 0 && (
                    <div className="space-y-2">
                      <p className="px-1 text-[11px] font-medium text-muted-foreground">
                        已连接 · {connectedList.length}
                      </p>
                      <SettingsCard>{connectedList.map(renderProviderRow)}</SettingsCard>
                    </div>
                  )}
                  {unconnectedList.length > 0 && (
                    <div className="space-y-2">
                      {connectedList.length > 0 && (
                        <p className="px-1 text-[11px] font-medium text-muted-foreground">
                          更多服务商 · {unconnectedList.length}
                        </p>
                      )}
                      <SettingsCard>{unconnectedList.map(renderProviderRow)}</SettingsCard>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </RevealContent>

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
                  <div key={`${notice.type}-${index}`} className="space-y-1 text-xs">
                    {notice.message && <p>{notice.message}</p>}
                    {notice.instructions && <p className="text-muted-foreground">{notice.instructions}</p>}
                    {notice.url && (
                      <a
                        className="break-all text-primary underline"
                        href={notice.url}
                        target="_blank"
                        rel="noreferrer"
                      >
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
                          className="ml-2 h-8 max-w-full rounded-lg text-xs shadow-none"
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
                  <p role="status" className="text-[11px] text-muted-foreground">
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
                    <p className="text-xs">{promptMessage}</p>
                    {prompt.type === 'select' ? (
                      <div className="space-y-2">
                        {prompt.options?.map((option) => (
                          <Button
                            key={option.id}
                            variant="outline"
                            className="h-auto w-full justify-start rounded-lg px-3 py-2 text-left text-xs shadow-none"
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
                                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                  {option.description}
                                </span>
                              )}
                            </span>
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Input
                          className={settingsControlClassName}
                          aria-label={promptMessage}
                          autoFocus
                          type={prompt.type === 'secret' && !showSecret ? 'password' : 'text'}
                          autoComplete="off"
                          value={answer}
                          placeholder={
                            login.authType === 'api_key' && prompt.type === 'secret'
                              ? promptMessage
                              : prompt.placeholder
                          }
                          onChange={(event) => setAnswer(event.target.value)}
                        />
                        {prompt.type === 'secret' && (
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
                            className="size-8 shrink-0 rounded-lg shadow-none"
                            onClick={() => setShowSecret((value) => !value)}
                          >
                            {showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                          </Button>
                        )}
                        <Button
                          className={cn(settingsControlClassName, 'shrink-0 whitespace-nowrap')}
                          type="submit"
                          disabled={submitting || !answer.trim()}
                        >
                          {submitting ? '提交中…' : '继续'}
                        </Button>
                      </div>
                    )}
                  </form>
                )}
                {login.error && login.status !== 'needs_input' && (
                  <p className="text-xs text-destructive">{login.error}</p>
                )}
                {login.reconnectError && (
                  <div role="alert" className="space-y-2">
                    <p className="text-xs text-destructive">{login.reconnectError}</p>
                    <Button
                      className={settingsControlClassName}
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
                  <p role="status" className="text-[11px] text-muted-foreground">
                    登录已保存。
                  </p>
                )}
                <div className="flex justify-end">
                  <Button className={settingsControlClassName} variant="outline" onClick={() => void closeLogin()}>
                    {login.status === 'running' || login.status === 'needs_input' ? '取消' : '关闭'}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </TooltipProvider>
  )
}
