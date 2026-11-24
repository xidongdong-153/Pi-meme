import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import type {
  McpBridge,
  McpCatalog,
  McpConfigSnapshot,
  McpService,
  McpTarget,
  SaveMcpServer,
} from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { OverflowTooltip, TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { cn } from '@pi-meme/ui/lib/utils'
import { ServerForm } from './server-form'
import { McpLoginPanel } from './login-panel'

export type McpSettingsLocation = { name: string; sessionKey?: string; revision?: string }

type StatusTone = 'success' | 'warning' | 'destructive' | 'info' | 'muted'

type ServiceStatus = {
  tone: StatusTone
  label: string
  detail?: string
}

const tonePillClass: Record<StatusTone, string> = {
  success: 'border-emerald-500/20 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/25 bg-amber-500/12 text-amber-600 dark:text-amber-400',
  destructive: 'border-destructive/25 bg-destructive/12 text-destructive',
  info: 'border-primary/25 bg-primary/12 text-primary',
  muted: 'border-border/60 bg-secondary/80 text-muted-foreground',
}

const toneDotClass: Record<StatusTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  destructive: 'bg-destructive',
  info: 'bg-primary',
  muted: 'bg-muted-foreground/60',
}

function getServiceStatus(service: McpService): ServiceStatus {
  if (service.error) return { tone: 'destructive', label: '配置错误', detail: service.error }
  if (!service.enabled) return { tone: 'muted', label: service.authorized ? '已停用' : '待启用' }
  if (service.loginId) return { tone: 'info', label: '授权中' }
  const check = service.check
  if (!check) return { tone: 'muted', label: '未检查' }
  if (check.state === 'connected') {
    return { tone: 'success', label: '已连接', detail: `${check.tools} 个工具` }
  }
  if (check.state === 'needs-auth') {
    return { tone: 'warning', label: '需登录', detail: check.message }
  }
  return { tone: 'destructive', label: '连接失败', detail: check.message }
}

function checkSummary(service: McpService) {
  const check = service.check
  if (!check) return '尚未检查连接'
  if (check.state === 'connected') return `连接正常 · 发现 ${check.tools} 个可用工具`
  return check.message
}

function authSummary(service: McpService) {
  if (service.authentication === 'auto') {
    if (service.signedIn) return { title: 'OAuth 已登录', icon: ShieldCheck }
    if (service.check?.state === 'connected') return { title: '无需登录', icon: ShieldCheck }
    return { title: 'OAuth 自动检测', icon: KeyRound }
  }
  if (service.authentication === 'headers') return { title: '使用请求头凭据', icon: KeyRound }
  if (service.authentication === 'provider') {
    return { title: `服务商账号 · ${service.provider}`, icon: ShieldCheck }
  }
  return { title: '本地进程环境变量', icon: Terminal }
}

function StatusPill({ status, showDetail = false }: { status: ServiceStatus; showDetail?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
        tonePillClass[status.tone],
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', toneDotClass[status.tone])} />
      <span>
        {status.label}
        {showDetail && status.detail && status.tone === 'success' ? ` · ${status.detail}` : ''}
      </span>
    </span>
  )
}

export function McpSettings({
  bridge,
  sessionKey,
  projectLabel,
  initial,
  renderProvider,
}: {
  bridge: McpBridge
  sessionKey?: string
  projectLabel?: string
  initial?: McpSettingsLocation
  renderProvider?: (id: string, onConnected: () => void) => ReactNode
}) {
  const [scope, setScope] = useState<'global' | 'project'>(sessionKey ? 'project' : 'global')
  const key = scope === 'project' ? sessionKey : undefined
  const [catalog, setCatalog] = useState<McpCatalog>()
  const [global, setGlobal] = useState<McpConfigSnapshot>()
  const [name, setName] = useState<string | undefined>(initial?.name)
  const [expectedRevision, setExpectedRevision] = useState(initial?.revision)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<'new' | 'edit'>()
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [toggling, setToggling] = useState<string>()
  const [checking, setChecking] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [login, setLogin] = useState<{ id: string; name: string }>()
  const [confirm, setConfirm] = useState<'delete' | 'logout'>()
  const [copiedEndpoint, setCopiedEndpoint] = useState(false)
  const sequence = useRef(0)
  const active = useRef(true)

  const load = useCallback(async () => {
    const seq = ++sequence.current
    try {
      const [list, config] = await Promise.all([bridge.getMcpCatalog(key), bridge.getMcpConfig()])
      if (seq === sequence.current && active.current) {
        setCatalog(list)
        setGlobal(config)
      }
      return list
    } catch (cause) {
      if (seq === sequence.current && active.current) setError(String(cause))
      throw cause
    }
  }, [bridge, key])

  useEffect(() => {
    active.current = true
    void load().catch(() => {})
    return () => {
      active.current = false
      sequence.current++
    }
  }, [load])

  useEffect(() => {
    if (!copiedEndpoint) return
    const timer = setTimeout(setCopiedEndpoint, 1600, false)
    return () => clearTimeout(timer)
  }, [copiedEndpoint])

  const refresh = useCallback(() => {
    void load().catch(() => {})
  }, [load])

  const handleManualRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setError('')
    try {
      await load()
    } catch {
      /* 错误已在 load 中设置 */
    } finally {
      if (active.current) setRefreshing(false)
    }
  }

  const selected = catalog?.services.find(
    (s) => s.name === name && (!expectedRevision || s.revision === expectedRevision),
  )
  const globalEntry = global?.servers.find((s) => s.name === name)

  const target = (service: McpService): McpTarget => ({
    name: service.name,
    revision: service.revision,
    sessionKey: key,
  })

  const reset = () => {
    setExpectedRevision(undefined)
    setName(undefined)
    setEditing(undefined)
    setConfirm(undefined)
    setLogin(undefined)
    setError('')
  }

  const open = (s: McpService) => {
    setExpectedRevision(s.revision)
    setName(s.name)
    setLogin(undefined)
    setEditing(undefined)
    setConfirm(undefined)
    setError('')
  }

  const toggleService = async (service: McpService, enabled: boolean) => {
    if (toggling || submitting) return
    setToggling(service.name)
    setError('')
    try {
      await bridge.setMcpServiceEnabled(target(service), enabled)
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      if (active.current) {
        await load().catch(() => {})
        setToggling(undefined)
      }
    }
  }

  const checkService = async (service: McpService) => {
    if (checking || submitting) return
    setChecking(service.name)
    setError('')
    try {
      await bridge.checkMcpService(target(service))
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      if (active.current) {
        await load().catch(() => {})
        setChecking(undefined)
      }
    }
  }

  const startLogin = async (service: McpService) => {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await bridge.startMcpLogin(target(service))
      if (active.current) setLogin({ id: result.id, name: service.name })
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      if (active.current) {
        await load().catch(() => {})
        setSubmitting(false)
      }
    }
  }

  const save = async (input: SaveMcpServer) => {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await bridge.saveMcpServer(input)
      setExpectedRevision(undefined)
      setEditing(undefined)
      setName(input.name)
      const list = await bridge.getMcpCatalog()
      const service = list.services.find((s) => s.name === input.name)
      if (service?.enabled && !service.error) {
        await bridge.checkMcpService({ name: service.name, revision: service.revision })
      }
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      if (active.current) {
        await load().catch(() => {})
        setSubmitting(false)
      }
    }
  }

  const confirmAction = async () => {
    if (!selected || !confirm || submitting) return
    setSubmitting(true)
    setError('')
    try {
      if (confirm === 'logout') {
        await bridge.logoutMcpService(target(selected))
      } else if (global) {
        await bridge.deleteMcpServer({ name: selected.name, revision: global.revision })
        reset()
      }
      if (active.current) {
        setConfirm(undefined)
        setLogin(undefined)
      }
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      if (active.current) {
        await load().catch(() => {})
        setSubmitting(false)
      }
    }
  }

  const copyEndpoint = async (endpoint: string) => {
    try {
      await navigator.clipboard.writeText(endpoint)
      setCopiedEndpoint(true)
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  }

  const authId = selected && (login?.name === selected.name ? login.id : selected.loginId)

  const providerFinished = useCallback(() => {
    if (selected) {
      void bridge
        .checkMcpService({ name: selected.name, revision: selected.revision, sessionKey: key })
        .then(refresh, (cause) => setError(String(cause)))
    }
  }, [bridge, key, selected?.name, selected?.revision, refresh])

  const systemErrors = [...new Set([global?.error, ...(catalog?.errors ?? [])].filter((v): v is string => Boolean(v)))]
  const allServices = catalog?.services ?? []
  const enabledCount = allServices.filter((s) => s.enabled).length
  const normalizedQuery = query.toLowerCase().trim()
  const list = normalizedQuery
    ? allServices.filter((s) =>
        [s.name, s.description, s.endpoint].some((v) => v?.toLowerCase().includes(normalizedQuery)),
      )
    : allServices
  const addDisabled = submitting || !global || !!global.error
  const addDisabledReason = global?.error ? '全局配置文件有误，修复后可新增服务' : !global ? '正在读取配置…' : undefined

  const renderNotices = () => (
    <>
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2.5 rounded-xl border border-destructive/30 bg-destructive/8 px-3.5 py-2.5 text-destructive"
        >
          <div className="flex min-w-0 items-start gap-2">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">{error}</p>
          </div>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setError('')}
            className="shrink-0 rounded p-0.5 opacity-75 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {systemErrors.map((notice) => (
        <div
          key={notice}
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-3.5 py-2.5 text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 break-words">{notice}</p>
        </div>
      ))}
    </>
  )

  return (
    <section
      aria-label="MCP 管理"
      className="space-y-5 text-xs"
      aria-busy={refreshing || submitting || Boolean(toggling) || Boolean(checking)}
    >
      {!name && !editing ? (
        <>
          {/* 顶部控制栏：范围分段 + 刷新/新增 */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {sessionKey ? (
              <div
                role="group"
                aria-label="配置范围"
                className="inline-flex h-8 max-w-full items-center rounded-lg border border-border/60 bg-secondary/50 p-0.5"
              >
                {(['global', 'project'] as const).map((s) => {
                  const activeScope = scope === s
                  const label = s === 'global' ? '全局服务' : `当前项目${projectLabel ? ` · ${projectLabel}` : ''}`
                  return (
                    <OverflowTooltip key={s} content={label}>
                      <button
                        type="button"
                        aria-pressed={activeScope}
                        onClick={() => {
                          if (scope === s) return
                          setScope(s)
                          setError('')
                        }}
                        className={cn(
                          'inline-flex h-7 max-w-52 cursor-pointer items-center truncate rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          activeScope
                            ? 'bg-background font-medium text-foreground shadow-xs'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <span className="truncate">{label}</span>
                      </button>
                    </OverflowTooltip>
                  )
                })}
              </div>
            ) : (
              <div className="text-muted-foreground">
                {catalog ? `共 ${allServices.length} 个服务 · 已启用 ${enabledCount} 个` : '全局服务'}
              </div>
            )}

            <div className="flex items-center gap-2">
              <TooltipHint content="刷新服务列表">
                <Button
                  size="icon"
                  variant="outline"
                  className={cn(settingsControlClassName, 'w-8 px-0')}
                  aria-label="刷新 MCP 服务"
                  disabled={refreshing}
                  onClick={() => void handleManualRefresh()}
                >
                  <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin motion-reduce:animate-none')} />
                </Button>
              </TooltipHint>
              {addDisabled && addDisabledReason ? (
                <TooltipHint content={addDisabledReason}>
                  <span tabIndex={0} className="inline-flex">
                    <Button className={settingsControlClassName} disabled>
                      <Plus className="size-3.5" />
                      新增服务
                    </Button>
                  </span>
                </TooltipHint>
              ) : (
                <Button
                  className={settingsControlClassName}
                  disabled={addDisabled}
                  onClick={() => {
                    setScope('global')
                    setEditing('new')
                    setError('')
                  }}
                >
                  <Plus className="size-3.5" />
                  新增服务
                </Button>
              )}
            </div>
          </div>

          {renderNotices()}

          {/* 搜索框（有服务或正在搜索时展示） */}
          {(allServices.length > 0 || query) && (
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="搜索 MCP 服务"
                placeholder="搜索服务名称、说明或地址"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 rounded-lg border-border/70 bg-secondary/40 pl-8 pr-8 text-xs shadow-none focus-visible:bg-background"
              />
              {query && (
                <TooltipHint content="清除搜索">
                  <button
                    type="button"
                    aria-label="清除搜索"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" />
                  </button>
                </TooltipHint>
              )}
            </div>
          )}

          {/* 服务列表 */}
          <SettingsGroup
            title={scope === 'project' ? '当前项目服务' : '全局服务'}
            action={
              catalog && sessionKey ? (
                <span className="text-[11px] text-muted-foreground select-none">
                  已启用 {enabledCount} / {allServices.length}
                </span>
              ) : undefined
            }
          >
            <SettingsCard>
              {list.map((service) => {
                const Icon = service.transport === 'http' ? Network : Terminal
                const status = getServiceStatus(service)
                const needsQuickLogin =
                  service.enabled &&
                  service.check?.state === 'needs-auth' &&
                  service.authentication === 'auto' &&
                  !service.loginId
                const isToggling = toggling === service.name
                const subline = service.error
                  ? service.error
                  : service.check?.state === 'failed'
                    ? service.check.message
                    : service.description || service.endpoint

                return (
                  <div
                    key={service.name}
                    className="group flex min-w-0 items-center gap-3 px-3.5 py-3 transition-colors duration-120 hover:bg-foreground/[0.025]"
                  >
                    <button
                      type="button"
                      onClick={() => open(service)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-lg"
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
                          status.tone === 'destructive'
                            ? 'border-destructive/25 bg-destructive/10 text-destructive'
                            : service.enabled
                              ? 'border-border/60 bg-secondary/80 text-foreground/85'
                              : 'border-border/40 bg-secondary/40 text-muted-foreground/70',
                        )}
                      >
                        <Icon aria-hidden="true" className="size-4" />
                      </span>

                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <OverflowTooltip content={service.name}>
                            <strong className="truncate text-[13px] font-medium text-foreground">{service.name}</strong>
                          </OverflowTooltip>
                          {scope === 'project' && (
                            <span className="shrink-0 rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 text-[10px] font-normal leading-none text-muted-foreground">
                              {service.source === 'global' ? '全局' : '项目'}
                            </span>
                          )}
                          <StatusPill status={status} showDetail />
                        </span>
                        <OverflowTooltip content={subline}>
                          <span
                            className={cn(
                              'block truncate text-[11px]',
                              status.tone === 'destructive'
                                ? 'text-destructive/90'
                                : service.description
                                  ? 'text-muted-foreground'
                                  : 'font-mono text-muted-foreground/85',
                            )}
                          >
                            {subline}
                          </span>
                        </OverflowTooltip>
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center gap-2">
                      {needsQuickLogin && (
                        <Button
                          variant="secondary"
                          size="xs"
                          disabled={submitting}
                          onClick={() => {
                            open(service)
                            void startLogin(service)
                          }}
                        >
                          <LogIn className="size-3" />
                          登录
                        </Button>
                      )}

                      {service.error ? (
                        <TooltipHint content="配置有误，请先修复">
                          <span tabIndex={0} className="inline-flex">
                            <Switch label={`启用 ${service.name}`} checked={service.enabled} disabled />
                          </span>
                        </TooltipHint>
                      ) : (
                        <Switch
                          label={`启用 ${service.name}`}
                          checked={service.enabled}
                          disabled={isToggling || submitting}
                          onChange={(value) => void toggleService(service, value)}
                        />
                      )}

                      <TooltipHint content="查看详情">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`查看 ${service.name} 详情`}
                          onClick={() => open(service)}
                          className="text-muted-foreground/70 group-hover:text-foreground"
                        >
                          <ChevronRight className="size-4" />
                        </Button>
                      </TooltipHint>
                    </div>
                  </div>
                )
              })}

              {!list.length && (
                <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
                  {!catalog ? (
                    <div role="status" className="ui-loading-delayed flex items-center gap-2 text-muted-foreground">
                      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                      <span>正在读取服务…</span>
                    </div>
                  ) : query ? (
                    <>
                      <span className="flex size-9 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                        <Search aria-hidden="true" className="size-4" />
                      </span>
                      <p role="status" className="font-medium text-foreground">
                        没有匹配的 MCP 服务
                      </p>
                      <Button variant="outline" size="xs" onClick={() => setQuery('')}>
                        清除搜索
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                        <Network aria-hidden="true" className="size-5" />
                      </span>
                      <p role="status" className="font-medium text-foreground">
                        尚未配置 MCP 服务
                      </p>
                      {!addDisabled && (
                        <Button
                          variant="secondary"
                          className={settingsControlClassName}
                          onClick={() => {
                            setScope('global')
                            setEditing('new')
                            setError('')
                          }}
                        >
                          <Plus className="size-3.5" />
                          新增 MCP 服务
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </SettingsCard>
          </SettingsGroup>
        </>
      ) : (
        <>
          {/* 详情/编辑页顶部返回与快捷操作 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="ghost"
              className={cn(settingsControlClassName, '-ml-2 px-2 text-muted-foreground hover:text-foreground')}
              disabled={submitting}
              onClick={reset}
            >
              <ArrowLeft className="size-3.5" />
              返回服务列表
            </Button>

            {!editing && selected && (
              <div className="flex items-center gap-1.5">
                {!key && globalEntry && (
                  <>
                    <Button
                      variant="outline"
                      className={settingsControlClassName}
                      disabled={submitting}
                      onClick={() => setEditing('edit')}
                    >
                      <Pencil className="size-3.5" />
                      编辑配置
                    </Button>
                    <TooltipHint content="删除此服务">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除 ${selected.name}`}
                        className={cn(
                          settingsControlClassName,
                          'w-8 px-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                        )}
                        disabled={submitting}
                        onClick={() => setConfirm('delete')}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TooltipHint>
                  </>
                )}
                {key && selected.source === 'global' && (
                  <Button
                    variant="outline"
                    className={settingsControlClassName}
                    disabled={submitting}
                    onClick={() => {
                      setExpectedRevision(undefined)
                      setScope('global')
                      setEditing('edit')
                    }}
                  >
                    <Pencil className="size-3.5" />
                    编辑全局配置
                  </Button>
                )}
              </div>
            )}
          </div>

          {renderNotices()}

          {editing ? (
            <SettingsGroup title={editing === 'new' ? '新增全局服务' : `编辑 ${name}`}>
              {global && (
                <ServerForm
                  key={`${editing}:${global.revision}`}
                  revision={global.revision}
                  entry={editing === 'edit' ? globalEntry : undefined}
                  busy={submitting}
                  onSave={save}
                  onCancel={() => {
                    if (editing === 'new') reset()
                    else setEditing(undefined)
                  }}
                />
              )}
            </SettingsGroup>
          ) : selected ? (
            <div className="space-y-5">
              {/* 服务概览头卡 */}
              <SettingsCard className="divide-y-0 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-xl border',
                      selected.error
                        ? 'border-destructive/25 bg-destructive/10 text-destructive'
                        : 'border-border/60 bg-secondary/80 text-foreground',
                    )}
                  >
                    {selected.transport === 'http' ? (
                      <Network aria-hidden="true" className="size-5" />
                    ) : (
                      <Terminal aria-hidden="true" className="size-5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-base font-semibold leading-tight text-foreground">
                        {selected.name}
                      </h3>
                      <StatusPill status={getServiceStatus(selected)} showDetail />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{selected.source === 'global' ? '全局配置' : '项目配置 (.pi/mcp.json)'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{selected.transport === 'http' ? 'HTTP' : 'stdio 本地进程'}</span>
                    </div>
                  </div>
                </div>

                {selected.description && (
                  <p className="text-xs leading-relaxed text-foreground/90">{selected.description}</p>
                )}

                {/* 端点地址条 */}
                <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/45 px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground select-text">
                    {selected.endpoint}
                  </code>
                  <TooltipHint content={copiedEndpoint ? '已复制' : '复制地址'}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="复制服务地址"
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => void copyEndpoint(selected.endpoint)}
                    >
                      {copiedEndpoint ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                    </Button>
                  </TooltipHint>
                </div>

                {selected.error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive"
                  >
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <p className="min-w-0 break-words">{selected.error}</p>
                  </div>
                )}
              </SettingsCard>

              {/* 使用与连接 */}
              <SettingsGroup title="使用与连接">
                <SettingsCard>
                  <SettingsRow>
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-medium text-foreground">{key ? '在当前项目启用' : '启用此服务'}</div>
                      {key && selected.source === 'project' && (
                        <div className="text-[11px] text-muted-foreground">仅作用于当前项目</div>
                      )}
                    </div>
                    <Switch
                      label={`启用 ${selected.name}`}
                      checked={selected.enabled}
                      disabled={toggling === selected.name || submitting || !!selected.error}
                      onChange={(value) => void toggleService(selected, value)}
                    />
                  </SettingsRow>
                  <SettingsRow>
                    <div className="flex min-w-0 items-start gap-2.5">
                      {checking === selected.name ? (
                        <LoaderCircle
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                        />
                      ) : selected.check?.state === 'connected' ? (
                        <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                      ) : selected.check?.state === 'failed' ? (
                        <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
                      ) : (
                        <Network aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 space-y-0.5">
                        <div
                          className={cn(
                            'break-words font-medium',
                            selected.check?.state === 'failed' ? 'text-destructive' : 'text-foreground',
                          )}
                        >
                          {checking === selected.name ? '正在检查连接…' : checkSummary(selected)}
                        </div>
                        {selected.check && (
                          <time className="block text-[11px] text-muted-foreground">
                            上次检查：{new Date(selected.check.checkedAt).toLocaleString()}
                          </time>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className={settingsControlClassName}
                      disabled={checking === selected.name || submitting || !selected.enabled || !!selected.error}
                      onClick={() => void checkService(selected)}
                    >
                      <RefreshCw
                        className={cn(
                          'size-3.5',
                          checking === selected.name && 'animate-spin motion-reduce:animate-none',
                        )}
                      />
                      {selected.check ? '重新检查' : '检查连接'}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsGroup>

              {/* 认证 */}
              <SettingsGroup title="认证">
                <SettingsCard>
                  <SettingsRow>
                    {(() => {
                      const auth = authSummary(selected)
                      const AuthIcon = auth.icon
                      return (
                        <div className="flex min-w-0 items-center gap-2.5">
                          <AuthIcon
                            aria-hidden="true"
                            className={cn(
                              'size-4 shrink-0',
                              selected.signedIn ? 'text-emerald-500' : 'text-muted-foreground',
                            )}
                          />
                          <span className="font-medium text-foreground">{auth.title}</span>
                        </div>
                      )
                    })()}

                    {selected.authentication === 'auto' &&
                      selected.enabled &&
                      (selected.signedIn || selected.check?.state === 'needs-auth') &&
                      !selected.loginId && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            className={settingsControlClassName}
                            disabled={submitting}
                            onClick={() => void startLogin(selected)}
                          >
                            <LogIn className="size-3.5" />
                            {selected.signedIn ? '重新登录' : `登录 ${selected.name}`}
                          </Button>
                          {selected.signedIn && (
                            <Button
                              variant="ghost"
                              className={cn(
                                settingsControlClassName,
                                'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                              )}
                              disabled={submitting}
                              onClick={() => setConfirm('logout')}
                            >
                              <LogOut className="size-3.5" />
                              退出登录
                            </Button>
                          )}
                        </div>
                      )}
                  </SettingsRow>

                  {authId && (
                    <div className="p-3.5">
                      <McpLoginPanel key={authId} id={authId} bridge={bridge} onFinished={refresh} />
                    </div>
                  )}

                  {selected.provider && renderProvider && (
                    <div className="p-3.5">{renderProvider(selected.provider, providerFinished)}</div>
                  )}
                </SettingsCard>
              </SettingsGroup>
            </div>
          ) : (
            <SettingsCard className="p-6 text-center">
              <p role="status" className="text-muted-foreground">
                {catalog ? '服务已移除或配置已变化，请返回列表重新选择。' : '正在读取服务…'}
              </p>
            </SettingsCard>
          )}

          {/* 删除 / 退出登录确认弹窗 */}
          <Dialog
            open={Boolean(confirm && selected)}
            onOpenChange={(next) => {
              if (!next && !submitting) setConfirm(undefined)
            }}
          >
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>{confirm === 'delete' ? '删除 MCP 服务' : '退出登录'}</DialogTitle>
                <DialogDescription>
                  {confirm === 'delete'
                    ? `确定删除全局服务「${selected?.name}」？后续聊天将无法再使用此配置。`
                    : `确定退出「${selected?.name}」的授权登录？使用此地址和账号的聊天需要重新登录。`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:space-x-0">
                <Button
                  variant="ghost"
                  className={settingsControlClassName}
                  disabled={submitting}
                  onClick={() => setConfirm(undefined)}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  className={settingsControlClassName}
                  disabled={submitting}
                  onClick={() => void confirmAction()}
                >
                  {submitting && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
                  {confirm === 'delete' ? '确认删除' : '确认退出'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  )
}
