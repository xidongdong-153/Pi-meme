import { useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  LoaderCircle,
  Network,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react'
import type { McpServerEntry, SaveMcpServer } from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Input } from '@pi-meme/ui/components/ui/input'
import { FormField } from '@pi-meme/ui/components/ui/form-field'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import { object, serverError } from '../shared/config'

type PairRow = { id: number; key: string; value: string }
type ArgRow = { id: number; value: string }

const stringify = (value: unknown, fallback: unknown) => JSON.stringify(value ?? fallback, null, 2)
const sensitiveKey = (key: string) => /auth|token|secret|key|password|bearer|cookie/i.test(key)

function recordToRows(value: unknown, nextId: () => number): PairRow[] {
  if (!object(value)) return []
  return Object.entries(value).map(([key, val]) => ({
    id: nextId(),
    key,
    value: typeof val === 'string' ? val : String(val ?? ''),
  }))
}

function rowsToRecord(rows: PairRow[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    result[key] = row.value
  }
  return result
}

function arrayToArgRows(value: unknown, nextId: () => number): ArgRow[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    id: nextId(),
    value: typeof item === 'string' ? item : String(item ?? ''),
  }))
}

function KeyValueEditor({
  label,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  disabled,
  onChange,
  onAdd,
}: {
  label: string
  rows: PairRow[]
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  disabled: boolean
  onChange: (rows: PairRow[]) => void
  onAdd: () => void
}) {
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium leading-snug text-foreground">{label}</span>
        <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onAdd}>
          <Plus className="size-3.5" />
          {addLabel}
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const isSensitive = sensitiveKey(row.key)
            const visible = !isSensitive || !!revealed[row.id]
            return (
              <div key={row.id} className="flex items-center gap-1.5">
                <Input
                  aria-label={`${label} 键`}
                  placeholder={keyPlaceholder}
                  autoComplete="off"
                  disabled={disabled}
                  value={row.key}
                  onChange={(event) =>
                    onChange(rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)))
                  }
                  className={cn(settingsControlClassName, 'w-[38%] shrink-0 bg-background font-mono text-[11px]')}
                />
                <div className="relative min-w-0 flex-1">
                  <Input
                    aria-label={`${label} 值`}
                    placeholder={valuePlaceholder}
                    autoComplete="off"
                    type={visible ? 'text' : 'password'}
                    disabled={disabled}
                    value={row.value}
                    onChange={(event) =>
                      onChange(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))
                    }
                    className={cn(
                      settingsControlClassName,
                      'w-full bg-background font-mono text-[11px]',
                      isSensitive && 'pr-8',
                    )}
                  />
                  {isSensitive && (
                    <TooltipHint content={visible ? '隐藏值' : '显示值'}>
                      <button
                        type="button"
                        aria-label={visible ? '隐藏值' : '显示值'}
                        disabled={disabled}
                        onClick={() => setRevealed((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </TooltipHint>
                  )}
                </div>
                <TooltipHint content="移除此项">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移除此项"
                    disabled={disabled}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipHint>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          暂未添加，点击右上角「{addLabel}」按需配置。
        </div>
      )}
    </div>
  )
}

function ArgsListEditor({
  rows,
  disabled,
  onChange,
  onAdd,
}: {
  rows: ArgRow[]
  disabled: boolean
  onChange: (rows: ArgRow[]) => void
  onAdd: () => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium leading-snug text-foreground">启动参数</span>
        <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onAdd}>
          <Plus className="size-3.5" />
          添加参数
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map((row, index) => (
            <div key={row.id} className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground select-none">
                {index + 1}
              </span>
              <Input
                aria-label={`第 ${index + 1} 个参数`}
                placeholder="例如 -y 或 @modelcontextprotocol/server-filesystem"
                autoComplete="off"
                disabled={disabled}
                value={row.value}
                onChange={(event) =>
                  onChange(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))
                }
                className={cn(settingsControlClassName, 'min-w-0 flex-1 bg-background font-mono text-[11px]')}
              />
              <TooltipHint content="移除参数">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="移除参数"
                  disabled={disabled}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipHint>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          无启动参数，点击右上角「添加参数」逐项填入。
        </div>
      )}
    </div>
  )
}

export function ServerForm({
  entry,
  revision,
  busy,
  onSave,
  onCancel,
}: {
  entry?: McpServerEntry
  revision: string
  busy: boolean
  onSave: (input: SaveMcpServer) => Promise<void>
  onCancel: () => void
}) {
  const idCounter = useRef(0)
  const nextId = () => ++idCounter.current

  const initial = object(entry?.config) ? entry.config : { url: '', exposure: 'codemode' }
  const [name, setName] = useState(entry?.name ?? '')
  const [config, setConfig] = useState<Record<string, unknown>>(initial)
  const [argRows, setArgRows] = useState<ArgRow[]>(() => arrayToArgRows(initial.args, nextId))
  const [envRows, setEnvRows] = useState<PairRow[]>(() => recordToRows(initial.env, nextId))
  const [headerRows, setHeaderRows] = useState<PairRow[]>(() => recordToRows(initial.headers, nextId))
  const [authMode, setAuthMode] = useState<'auto' | 'headers' | 'provider'>(() =>
    initial.auth
      ? 'provider'
      : object(initial.headers) && Object.keys(initial.headers).some((key) => key.toLowerCase() === 'authorization')
        ? 'headers'
        : 'auto',
  )
  const [oauthOpen, setOauthOpen] = useState(() => object(initial.oauth) && Object.keys(initial.oauth).length > 0)
  const [showSecret, setShowSecret] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState(() => stringify(initial, {}))
  const [error, setError] = useState('')

  const http = 'url' in config || !('command' in config)

  const compose = () => {
    const next: Record<string, unknown> = { ...config }
    if (http) {
      const headersObj = rowsToRecord(headerRows)
      if (Object.keys(headersObj).length > 0) next.headers = headersObj
      else delete next.headers
      if (authMode !== 'provider') delete next.auth
      if (authMode !== 'auto') delete next.oauth
    } else {
      const argsArr = argRows.map((row) => row.value)
      if (argsArr.length > 0) next.args = argsArr
      else delete next.args
      const envObj = rowsToRecord(envRows)
      if (Object.keys(envObj).length > 0) next.env = envObj
      else delete next.env
    }
    return next
  }

  const switchMode = (targetAdvanced: boolean) => {
    if (targetAdvanced === advanced) return
    try {
      if (!targetAdvanced) {
        const next: unknown = JSON.parse(json)
        if (!object(next)) throw new Error('高级配置必须是 JSON 对象')
        setConfig(next)
        setAuthMode(
          next.auth
            ? 'provider'
            : object(next.headers) && Object.keys(next.headers).some((key) => key.toLowerCase() === 'authorization')
              ? 'headers'
              : 'auto',
        )
        setArgRows(arrayToArgRows(next.args, nextId))
        setEnvRows(recordToRows(next.env, nextId))
        setHeaderRows(recordToRows(next.headers, nextId))
        setOauthOpen(object(next.oauth) && Object.keys(next.oauth).length > 0)
      } else {
        setJson(stringify(compose(), {}))
      }
      setAdvanced(targetAdvanced)
      setError('')
    } catch {
      setError('配置 JSON 无效，请修正后再切换到表单')
    }
  }

  const switchTransport = (value: 'http' | 'stdio') => {
    if ((value === 'http') === http) return
    const next = { ...config }
    if (value === 'http') {
      delete next.command
      delete next.args
      delete next.env
      delete next.cwd
      next.url = typeof next.url === 'string' ? next.url : ''
      next.type = 'http'
    } else {
      delete next.url
      delete next.headers
      delete next.oauth
      delete next.auth
      next.command = typeof next.command === 'string' ? next.command : ''
      next.type = 'stdio'
    }
    setConfig(next)
    setError('')
  }

  const formatJson = () => {
    try {
      const parsed: unknown = JSON.parse(json)
      setJson(JSON.stringify(parsed, null, 2))
      setError('')
    } catch {
      setError('JSON 语法有误，无法格式化')
    }
  }

  const field = (
    label: string,
    value: unknown,
    key: string,
    options?: { placeholder?: string; description?: string; mono?: boolean },
  ) => (
    <FormField label={label} description={options?.description}>
      <Input
        className={cn(settingsControlClassName, 'bg-background', options?.mono && 'font-mono text-[11px]')}
        aria-label={label}
        placeholder={options?.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setConfig({ ...config, [key]: event.target.value })}
        disabled={busy}
      />
    </FormField>
  )

  return (
    <form
      aria-label="MCP 服务编辑"
      className="space-y-5 rounded-xl border border-border/70 bg-card/40 p-4 text-xs"
      onSubmit={async (event) => {
        event.preventDefault()
        try {
          const next: unknown = advanced ? JSON.parse(json) : compose()
          const issue = serverError(name, next)
          if (issue) {
            setError(issue)
            return
          }
          setError('')
          await onSave({ name, previousName: entry?.name, revision, config: next })
        } catch (cause) {
          setError(cause instanceof SyntaxError ? '配置 JSON 无效，请检查语法后重试' : String(cause))
        }
      }}
    >
      {/* 顶部：服务名称 + 表单/JSON 模式分段切换 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FormField label="服务名称" className="min-w-44 flex-1">
          <Input
            className={cn(settingsControlClassName, 'bg-background font-mono')}
            aria-label="MCP 服务名称"
            placeholder="例如 github、linear 或 local-tools"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </FormField>
        <div
          role="group"
          aria-label="编辑模式"
          className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border/60 bg-secondary/50 p-0.5"
        >
          <button
            type="button"
            aria-pressed={!advanced}
            disabled={busy}
            onClick={() => switchMode(false)}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
              !advanced
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <SlidersHorizontal aria-hidden="true" className="size-3.5" />
            表单
          </button>
          <button
            type="button"
            aria-pressed={advanced}
            disabled={busy}
            onClick={() => switchMode(true)}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
              advanced
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Code2 aria-hidden="true" className="size-3.5" />
            高级 JSON
          </button>
        </div>
      </div>

      {advanced ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="mcp-advanced-json" className="font-medium text-foreground">
              服务配置 JSON
            </label>
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={formatJson}>
              <Sparkles className="size-3.5" />
              格式化
            </Button>
          </div>
          <Textarea
            id="mcp-advanced-json"
            aria-label="MCP 高级 JSON"
            className="min-h-60 rounded-lg bg-background font-mono text-[11px] leading-relaxed select-text"
            rows={14}
            value={json}
            onChange={(event) => setJson(event.target.value)}
            disabled={busy}
          />
          <p className="text-[11px] text-muted-foreground">
            支持配置 <code className="rounded bg-secondary px-1 py-0.5 font-mono">timeout</code>、
            <code className="rounded bg-secondary px-1 py-0.5 font-mono">exposure</code>、
            <code className="rounded bg-secondary px-1 py-0.5 font-mono">toolExposure</code> 与 OAuth 回调地址。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 连接类型双卡选择 */}
          <div className="space-y-2">
            <span className="block font-medium leading-snug text-foreground">连接类型</span>
            <div role="radiogroup" aria-label="MCP 连接类型" className="grid grid-cols-2 gap-2">
              {(
                [
                  {
                    value: 'http',
                    title: 'HTTP 远程服务',
                    hint: 'URL · OAuth · 请求头',
                    icon: Network,
                  },
                  {
                    value: 'stdio',
                    title: 'stdio 本地进程',
                    hint: '命令 · 参数 · 环境变量',
                    icon: Terminal,
                  },
                ] as const
              ).map((option) => {
                const active = (option.value === 'http') === http
                const Icon = option.icon
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={busy}
                    onClick={() => switchTransport(option.value)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                      active
                        ? 'border-primary/60 bg-primary/8 text-foreground'
                        : 'border-border/70 bg-background/60 text-muted-foreground hover:border-border hover:bg-background hover:text-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-md',
                        active ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{option.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{option.hint}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 连接参数区块 */}
          <div className="space-y-4 border-t border-border/50 pt-4">
            {http ? (
              <>
                {field('MCP URL', config.url, 'url', {
                  placeholder: 'https://mcp.example.com/mcp',
                  mono: true,
                })}

                <FormField label="认证方式">
                  <Select
                    value={authMode}
                    disabled={busy}
                    onValueChange={(value: typeof authMode) => {
                      let nextRows = [...headerRows]
                      if (value !== 'headers') {
                        nextRows = nextRows.filter((row) => row.key.trim().toLowerCase() !== 'authorization')
                      } else if (!nextRows.some((row) => row.key.trim().toLowerCase() === 'authorization')) {
                        nextRows = [{ id: nextId(), key: 'Authorization', value: '' }, ...nextRows]
                      }
                      setHeaderRows(nextRows)
                      setAuthMode(value)
                      setError('')
                      if (value === 'provider' && !config.auth) setConfig({ ...config, auth: { provider: '' } })
                    }}
                  >
                    <SelectTrigger aria-label="认证方式" className={cn(settingsControlClassName, 'bg-background')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动检测 / OAuth</SelectItem>
                      <SelectItem value="headers">请求头凭据</SelectItem>
                      <SelectItem value="provider">使用服务商账号</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>

                {authMode === 'provider' && (
                  <FormField label="服务商 ID">
                    <Input
                      aria-label="服务商 ID"
                      placeholder="例如 openai、anthropic"
                      className={cn(settingsControlClassName, 'bg-background font-mono')}
                      disabled={busy}
                      value={object(config.auth) ? String(config.auth.provider ?? '') : ''}
                      onChange={(event) => setConfig({ ...config, auth: { provider: event.target.value } })}
                    />
                  </FormField>
                )}

                {authMode === 'auto' && (
                  <div className="rounded-lg border border-border/60 bg-background/50">
                    <button
                      type="button"
                      aria-expanded={oauthOpen}
                      onClick={() => setOauthOpen((v) => !v)}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-lg"
                    >
                      <span>OAuth 客户端设置（可选）</span>
                      <ChevronDown
                        aria-hidden="true"
                        className={cn('size-3.5 transition-transform duration-150', oauthOpen && 'rotate-180')}
                      />
                    </button>
                    {oauthOpen && (
                      <div className="space-y-3 border-t border-border/50 px-3 py-3">
                        <FormField label="客户端 ID">
                          <Input
                            disabled={busy}
                            autoComplete="off"
                            className={cn(settingsControlClassName, 'bg-background font-mono text-[11px]')}
                            value={object(config.oauth) ? String(config.oauth.clientId ?? '') : ''}
                            onChange={(event) => {
                              const oauth = { ...(object(config.oauth) ? config.oauth : {}) }
                              if (event.target.value) oauth.clientId = event.target.value
                              else delete oauth.clientId
                              setConfig({ ...config, oauth })
                            }}
                          />
                        </FormField>
                        <FormField label="客户端密钥">
                          <div className="relative">
                            <Input
                              disabled={busy}
                              type={showSecret ? 'text' : 'password'}
                              autoComplete="off"
                              className={cn(settingsControlClassName, 'bg-background pr-8 font-mono text-[11px]')}
                              value={object(config.oauth) ? String(config.oauth.clientSecret ?? '') : ''}
                              onChange={(event) => {
                                const oauth = { ...(object(config.oauth) ? config.oauth : {}) }
                                if (event.target.value) oauth.clientSecret = event.target.value
                                else delete oauth.clientSecret
                                setConfig({ ...config, oauth })
                              }}
                            />
                            <TooltipHint content={showSecret ? '隐藏密钥' : '显示密钥'}>
                              <button
                                type="button"
                                aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
                                onClick={() => setShowSecret((v) => !v)}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              >
                                {showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                              </button>
                            </TooltipHint>
                          </div>
                        </FormField>
                        <FormField label="授权范围（Scope）">
                          <Input
                            disabled={busy}
                            autoComplete="off"
                            placeholder="空格分隔的权限范围"
                            className={cn(settingsControlClassName, 'bg-background font-mono text-[11px]')}
                            value={object(config.oauth) ? String(config.oauth.scope ?? '') : ''}
                            onChange={(event) => {
                              const oauth = { ...(object(config.oauth) ? config.oauth : {}) }
                              if (event.target.value) oauth.scope = event.target.value
                              else delete oauth.scope
                              setConfig({ ...config, oauth })
                            }}
                          />
                        </FormField>
                      </div>
                    )}
                  </div>
                )}

                <KeyValueEditor
                  label="自定义请求头"
                  rows={headerRows}
                  keyPlaceholder="Header 名称，如 Authorization"
                  valuePlaceholder="值，如 Bearer ..."
                  addLabel="添加请求头"
                  disabled={busy}
                  onChange={setHeaderRows}
                  onAdd={() => setHeaderRows((prev) => [...prev, { id: nextId(), key: '', value: '' }])}
                />
              </>
            ) : (
              <>
                {field('可执行命令', config.command, 'command', {
                  placeholder: '例如 npx、uvx 或绝对路径',
                  description: '填写单个可执行文件，参数逐项填入下方，不拼接 Shell 命令。',
                  mono: true,
                })}

                <ArgsListEditor
                  rows={argRows}
                  disabled={busy}
                  onChange={setArgRows}
                  onAdd={() => setArgRows((prev) => [...prev, { id: nextId(), value: '' }])}
                />

                <KeyValueEditor
                  label="环境变量"
                  rows={envRows}
                  keyPlaceholder="变量名，如 API_KEY"
                  valuePlaceholder="变量值"
                  addLabel="添加变量"
                  disabled={busy}
                  onChange={setEnvRows}
                  onAdd={() => setEnvRows((prev) => [...prev, { id: nextId(), key: '', value: '' }])}
                />

                {field('工作目录（可选）', config.cwd, 'cwd', {
                  placeholder: '留空则使用默认工作目录',
                  mono: true,
                })}
              </>
            )}

            <div className="border-t border-border/50 pt-4">
              {field('服务说明（可选）', config.description, 'description', {
                placeholder: '简述该服务提供的能力，便于后续识别',
              })}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 break-words">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button className={settingsControlClassName} type="submit" disabled={busy}>
            {busy && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
            保存并检查
          </Button>
          <Button className={settingsControlClassName} type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        </div>
        {!advanced && <span className="text-[11px] text-muted-foreground">超时、暴露方式等可在高级 JSON 中设置</span>}
      </div>
    </form>
  )
}
