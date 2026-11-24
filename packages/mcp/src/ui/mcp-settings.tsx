import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Network, RefreshCw, Terminal } from 'lucide-react'
import { IntegrationHeader } from '@pi-meme/ui/components/integration-header'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import type {
  McpBridge,
  McpCatalog,
  McpConfigSnapshot,
  McpService,
  McpTarget,
  SaveMcpServer,
} from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { ServerForm } from './server-form'
import { McpLoginPanel } from './login-panel'

export type McpSettingsLocation = { name: string; sessionKey?: string; revision?: string }
function checkLabel(service: McpService) {
  const check = service.check
  if (!check) return '尚未检查'
  if (check.state === 'connected') return `检查成功 · ${check.tools} 个工具`
  return check.message
}
function summary(service: McpService) {
  if (service.error) return service.error
  if (!service.enabled) return service.authorized ? '已停用' : '待启用授权'
  if (service.loginId) return '授权进行中'
  return checkLabel(service)
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
  const [working, setWorking] = useState('')
  const [login, setLogin] = useState<{ id: string; name: string }>()
  const [confirm, setConfirm] = useState<'delete' | 'logout'>()
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
    setCatalog(undefined)
    void load().catch(() => {})
    return () => {
      active.current = false
      sequence.current++
    }
  }, [load])
  const refresh = useCallback(() => {
    void load().catch(() => {})
  }, [load])
  const selected = catalog?.services.find(
    (s) => s.name === name && (!expectedRevision || s.revision === expectedRevision),
  )
  const globalEntry = global?.servers.find((s) => s.name === name)
  const target = (service: McpService): McpTarget => ({
    name: service.name,
    revision: service.revision,
    sessionKey: key,
  })
  const run = async (label: string, action: () => Promise<unknown>) => {
    if (working) return
    setWorking(label)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (active.current) setError(String(cause))
    } finally {
      if (active.current) {
        await load().catch(() => {})
        setWorking('')
      }
    }
  }
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
  const save = (input: SaveMcpServer) =>
    run('保存中…', async () => {
      await bridge.saveMcpServer(input)
      setExpectedRevision(undefined)
      setEditing(undefined)
      setName(input.name)
      const list = await bridge.getMcpCatalog()
      const service = list.services.find((s) => s.name === input.name)
      if (service?.enabled && !service.error)
        await bridge.checkMcpService({ name: service.name, revision: service.revision })
    })
  const startLogin = (service: McpService) =>
    void run('准备授权…', async () => {
      const result = await bridge.startMcpLogin(target(service))
      setLogin({ id: result.id, name: service.name })
    })
  const check = (service: McpService) => void run('正在检查…', () => bridge.checkMcpService(target(service)))
  const authId = selected && (login?.name === selected.name ? login.id : selected.loginId)
  const providerFinished = useCallback(() => {
    if (selected)
      void bridge
        .checkMcpService({ name: selected.name, revision: selected.revision, sessionKey: key })
        .then(refresh, (cause) => setError(String(cause)))
  }, [bridge, key, selected?.name, selected?.revision, refresh])
  const notices = [...new Set([error, global?.error, ...(catalog?.errors ?? [])].filter(Boolean))]
  const disabled = !!working
  const list = (catalog?.services ?? []).filter((s) =>
    [s.name, s.description].some((v) => v?.toLowerCase().includes(query.toLowerCase().trim())),
  )
  return (
    <section aria-label="MCP 管理" className="space-y-5 text-xs" aria-busy={disabled}>
      {!name && !editing ? (
        <>
          <IntegrationHeader
            query={query}
            onQuery={setQuery}
            searchLabel="搜索 MCP 服务"
            actions={
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="刷新 MCP 服务"
                  disabled={disabled}
                  onClick={() => void run('刷新中…', load)}
                >
                  <RefreshCw />
                </Button>
                <Button
                  className={settingsControlClassName}
                  disabled={disabled || !global || !!global.error}
                  onClick={() => {
                    setScope('global')
                    setEditing('new')
                  }}
                >
                  新增 MCP 服务
                </Button>
              </>
            }
          />
          <div role="group" aria-label="配置范围" className="flex flex-wrap gap-1">
            {(['global', 'project'] as const)
              .filter((s) => s === 'global' || sessionKey)
              .map((s) => (
                <Button
                  key={s}
                  variant={scope === s ? 'secondary' : 'ghost'}
                  className={settingsControlClassName}
                  disabled={disabled}
                  aria-pressed={scope === s}
                  onClick={() => {
                    setScope(s)
                    reset()
                  }}
                >
                  {s === 'global' ? '全局服务' : `当前项目${projectLabel ? ` · ${projectLabel}` : ''}`}
                </Button>
              ))}
          </div>
          <SettingsGroup title="服务">
            <SettingsCard>
              {list.map((service) => {
                const Icon = service.transport === 'http' ? Network : Terminal
                return (
                  <SettingsRow key={service.name} className="flex-nowrap">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(service)}>
                      <strong className="block truncate">{service.name}</strong>
                      <span className="block truncate text-muted-foreground">
                        {service.source === 'global' ? '全局' : '项目'} · {summary(service)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        open(service)
                        if (
                          service.check?.state === 'needs-auth' &&
                          service.authentication === 'auto' &&
                          !service.loginId
                        )
                          startLogin(service)
                      }}
                    >
                      {service.check?.state === 'needs-auth' && service.authentication === 'auto' ? '登录' : '查看'}
                      <ChevronRight className="size-4" />
                    </Button>
                  </SettingsRow>
                )
              })}
              {!list.length && (
                <p role="status" className="p-4 text-muted-foreground">
                  {!catalog ? '正在读取服务…' : query ? '没有匹配的服务' : '尚未配置 MCP 服务'}
                </p>
              )}
            </SettingsCard>
          </SettingsGroup>
        </>
      ) : (
        <>
          <Button variant="ghost" className={settingsControlClassName} disabled={disabled} onClick={reset}>
            <ArrowLeft />
            返回 MCP 服务
          </Button>
          {editing ? (
            <SettingsGroup title={editing === 'new' ? '新增全局服务' : `编辑 ${name}`}>
              {global && (
                <ServerForm
                  key={`${editing}:${global.revision}`}
                  revision={global.revision}
                  entry={editing === 'edit' ? globalEntry : undefined}
                  busy={disabled}
                  onSave={save}
                  onCancel={() => setEditing(undefined)}
                />
              )}
            </SettingsGroup>
          ) : selected ? (
            <>
              <div className="min-w-0 space-y-1">
                <h3 className="break-words text-base font-semibold">{selected.name}</h3>
                <p className="break-all text-muted-foreground">
                  {selected.source === 'global' ? '全局配置' : '项目配置'} ·{' '}
                  {selected.transport === 'http' ? 'HTTP' : '本地进程'} · {selected.endpoint}
                </p>
                {selected.description && <p>{selected.description}</p>}
              </div>
              <SettingsGroup title="使用与连接">
                <SettingsCard>
                  <SettingsRow>
                    <span>{key ? '允许当前项目使用' : '允许使用此服务'}</span>
                    <Switch
                      label={`启用 ${selected.name}`}
                      checked={selected.enabled}
                      disabled={disabled || !!selected.error}
                      onChange={(value) =>
                        void run('保存中…', () => bridge.setMcpServiceEnabled(target(selected), value))
                      }
                    />
                  </SettingsRow>
                  <SettingsRow>
                    <div>
                      <div>{checkLabel(selected)}</div>
                      {selected.check && (
                        <time className="text-muted-foreground">
                          {new Date(selected.check.checkedAt).toLocaleString()}
                        </time>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      className={settingsControlClassName}
                      disabled={disabled || !selected.enabled || !!selected.error}
                      onClick={() => check(selected)}
                    >
                      {selected.check ? '重新检查' : '检查连接'}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsGroup>
              <SettingsGroup title="认证">
                <SettingsCard>
                  <SettingsRow>
                    <div>
                      {selected.authentication === 'auto'
                        ? selected.signedIn
                          ? 'OAuth 已登录'
                          : selected.check?.state === 'connected'
                            ? '无需登录'
                            : 'OAuth 自动检测'
                        : selected.authentication === 'headers'
                          ? '使用请求头凭据'
                          : selected.authentication === 'provider'
                            ? `使用服务商账号 · ${selected.provider}`
                            : '使用本地进程环境变量'}
                    </div>
                    {selected.authentication === 'auto' &&
                      selected.enabled &&
                      (selected.signedIn || selected.check?.state === 'needs-auth') &&
                      !selected.loginId && (
                        <div className="flex gap-1">
                          <Button
                            className={settingsControlClassName}
                            disabled={disabled}
                            onClick={() => startLogin(selected)}
                          >
                            {selected.signedIn ? '重新登录' : `登录 ${selected.name}`}
                          </Button>
                          {selected.signedIn && (
                            <Button
                              variant="ghost"
                              className={settingsControlClassName}
                              disabled={disabled}
                              onClick={() => setConfirm('logout')}
                            >
                              退出登录
                            </Button>
                          )}
                        </div>
                      )}
                  </SettingsRow>
                  {authId && (
                    <div className="p-4">
                      <McpLoginPanel key={authId} id={authId} bridge={bridge} onFinished={refresh} />
                    </div>
                  )}
                  {selected.provider && renderProvider && (
                    <div className="p-3">{renderProvider(selected.provider, providerFinished)}</div>
                  )}
                </SettingsCard>
              </SettingsGroup>
              {!key && globalEntry && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className={settingsControlClassName}
                    disabled={disabled}
                    onClick={() => setEditing('edit')}
                  >
                    编辑配置
                  </Button>
                  <Button
                    variant="ghost"
                    className={settingsControlClassName}
                    disabled={disabled}
                    onClick={() => setConfirm('delete')}
                  >
                    删除服务
                  </Button>
                </div>
              )}
              {key && selected.source === 'global' && (
                <Button
                  variant="outline"
                  className={settingsControlClassName}
                  disabled={disabled}
                  onClick={() => {
                    setExpectedRevision(undefined)
                    setScope('global')
                    setEditing('edit')
                  }}
                >
                  编辑全局配置
                </Button>
              )}
              {key && selected.source === 'project' && (
                <p className="text-muted-foreground">项目设置来自 .pi/mcp.json。此处的启停仅作用于当前项目。</p>
              )}
              {confirm && (
                <SettingsCard className="space-y-3 divide-y-0 p-4">
                  <p>
                    {confirm === 'delete'
                      ? `删除全局服务 ${selected.name}？后续聊天将无法使用此配置。`
                      : `退出 ${selected.name}？使用此地址和账号的聊天将需要重新登录。`}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      className={settingsControlClassName}
                      disabled={disabled}
                      onClick={() =>
                        void run('处理中…', async () => {
                          if (confirm === 'logout') await bridge.logoutMcpService(target(selected))
                          else if (global) {
                            await bridge.deleteMcpServer({ name: selected.name, revision: global.revision })
                            reset()
                          }
                          setConfirm(undefined)
                          setLogin(undefined)
                        })
                      }
                    >
                      确认{confirm === 'delete' ? '删除' : '退出'}
                    </Button>
                    <Button variant="ghost" disabled={disabled} onClick={() => setConfirm(undefined)}>
                      取消
                    </Button>
                  </div>
                </SettingsCard>
              )}
            </>
          ) : (
            <p role="status">{catalog ? '服务已移除或配置已变化，请返回列表重新选择。' : '正在读取服务…'}</p>
          )}
        </>
      )}
      {working && (
        <p role="status" className="text-muted-foreground">
          {working}
        </p>
      )}
      {notices.map((notice) => (
        <p key={notice} role="alert" className="break-words text-destructive">
          {notice}
        </p>
      ))}
    </section>
  )
}
