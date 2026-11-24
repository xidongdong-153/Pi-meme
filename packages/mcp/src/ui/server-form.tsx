import { useState } from 'react'
import type { McpServerEntry, SaveMcpServer } from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import { settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Input } from '@pi-meme/ui/components/ui/input'
import { FormField } from '@pi-meme/ui/components/ui/form-field'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { object, serverError } from '../shared/config'

const stringify = (value: unknown, fallback: unknown) => JSON.stringify(value ?? fallback, null, 2)

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
  const initial = object(entry?.config) ? entry.config : { url: '', exposure: 'codemode' }
  const [name, setName] = useState(entry?.name ?? '')
  const [config, setConfig] = useState(initial)
  const [args, setArgs] = useState(() => stringify(initial.args, []))
  const [env, setEnv] = useState(() => stringify(initial.env, {}))
  const [headers, setHeaders] = useState(() => stringify(initial.headers, {}))
  const [authMode, setAuthMode] = useState<'auto' | 'headers' | 'provider'>(() =>
    initial.auth
      ? 'provider'
      : object(initial.headers) && Object.keys(initial.headers).some((key) => key.toLowerCase() === 'authorization')
        ? 'headers'
        : 'auto',
  )
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState(() => stringify(initial, {}))
  const [error, setError] = useState('')
  const http = 'url' in config || !('command' in config)
  const compose = () => {
    const next = { ...config }
    if (http) {
      next.headers = JSON.parse(headers)
      if (authMode !== 'provider') delete next.auth
      if (authMode !== 'auto') delete next.oauth
    } else {
      next.args = JSON.parse(args)
      next.env = JSON.parse(env)
    }
    return next
  }
  const changeMode = () => {
    try {
      if (advanced) {
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
        setArgs(stringify(next.args, []))
        setEnv(stringify(next.env, {}))
        setHeaders(stringify(next.headers, {}))
      } else setJson(stringify(compose(), {}))
      setAdvanced(!advanced)
      setError('')
    } catch {
      setError('配置 JSON 无效，请修正后再切换')
    }
  }
  const field = (label: string, value: unknown, key: string, description?: string) => (
    <FormField label={label} description={description}>
      <Input
        className={settingsControlClassName}
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setConfig({ ...config, [key]: event.target.value })}
        disabled={busy}
      />
    </FormField>
  )
  return (
    <form
      aria-label="MCP 服务编辑"
      className="space-y-4 rounded-xl border border-border/70 bg-card/40 p-4 text-xs"
      onSubmit={async (event) => {
        event.preventDefault()
        try {
          const next: unknown = advanced ? JSON.parse(json) : compose()
          const issue = serverError(name, next)
          if (issue) {
            setError(issue)
            return
          }
          await onSave({ name, previousName: entry?.name, revision, config: next })
        } catch (cause) {
          setError(cause instanceof SyntaxError ? '配置 JSON 无效，请检查参数、环境变量或 Headers' : String(cause))
        }
      }}
    >
      <FormField label="服务名称">
        <Input
          className={settingsControlClassName}
          aria-label="MCP 服务名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </FormField>
      <Button
        className={settingsControlClassName}
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={changeMode}
      >
        {advanced ? '切换到表单' : '编辑高级 JSON'}
      </Button>
      {advanced ? (
        <FormField label="单个服务的原生 JSON">
          <Textarea
            aria-label="MCP 高级 JSON"
            className="font-mono text-xs select-text rounded-lg"
            rows={14}
            value={json}
            onChange={(event) => setJson(event.target.value)}
            disabled={busy}
          />
        </FormField>
      ) : (
        <>
          <FormField label="连接类型">
            <Select
              value={http ? 'http' : 'stdio'}
              disabled={busy}
              onValueChange={(value) => {
                const next = { ...config }
                if (value === 'http') {
                  delete next.command
                  delete next.args
                  delete next.env
                  delete next.cwd
                  next.url = ''
                  next.type = 'http'
                } else {
                  delete next.url
                  delete next.headers
                  delete next.oauth
                  delete next.auth
                  next.command = ''
                  next.type = 'stdio'
                }
                setConfig(next)
              }}
            >
              <SelectTrigger
                aria-label="MCP 连接类型"
                className="bg-background h-8 max-w-full rounded-lg text-xs shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="stdio">stdio 本地进程</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {http ? (
            <>
              {field('MCP URL', config.url, 'url')}
              <FormField label="认证方式">
                <Select
                  value={authMode}
                  disabled={busy}
                  onValueChange={(value: typeof authMode) => {
                    try {
                      const nextHeaders: unknown = JSON.parse(headers)
                      if (!object(nextHeaders)) throw new Error('请求头必须是 JSON 对象')
                      if (value !== 'headers')
                        for (const key of Object.keys(nextHeaders))
                          if (key.toLowerCase() === 'authorization') delete nextHeaders[key]
                      if (
                        value === 'headers' &&
                        !Object.keys(nextHeaders).some((key) => key.toLowerCase() === 'authorization')
                      )
                        nextHeaders.Authorization = ''
                      setHeaders(stringify(nextHeaders, {}))
                      setAuthMode(value)
                      setError('')
                      if (value === 'provider' && !config.auth) setConfig({ ...config, auth: { provider: '' } })
                    } catch {
                      setError('请先修正请求头 JSON')
                    }
                  }}
                >
                  <SelectTrigger aria-label="认证方式" className={settingsControlClassName}>
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
                    disabled={busy}
                    value={object(config.auth) ? String(config.auth.provider ?? '') : ''}
                    onChange={(event) => setConfig({ ...config, auth: { provider: event.target.value } })}
                  />
                </FormField>
              )}
              {authMode === 'auto' && (
                <details className="space-y-3">
                  <summary className="cursor-pointer text-muted-foreground">OAuth 客户端设置</summary>
                  {(['clientId', 'clientSecret', 'scope'] as const).map((key, i) => (
                    <FormField key={key} label={['客户端 ID', '客户端密钥', '授权范围'][i]}>
                      <Input
                        disabled={busy}
                        type={key === 'clientSecret' ? 'password' : 'text'}
                        autoComplete="off"
                        value={object(config.oauth) ? String(config.oauth[key] ?? '') : ''}
                        onChange={(event) => {
                          const oauth = { ...(object(config.oauth) ? config.oauth : {}) }
                          if (event.target.value) oauth[key] = event.target.value
                          else delete oauth[key]
                          setConfig({ ...config, oauth })
                        }}
                      />
                    </FormField>
                  ))}
                </details>
              )}
              <FormField label="请求头（JSON）">
                <Textarea
                  aria-label="MCP Headers"
                  rows={4}
                  className="font-mono text-xs select-text rounded-lg"
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  disabled={busy}
                />
              </FormField>
            </>
          ) : (
            <>
              {field(
                '可执行命令',
                config.command,
                'command',
                '命令填写单个可执行文件，参数填入下方数组，不拼接 Shell 命令。',
              )}
              <FormField label="参数（JSON 字符串数组）">
                <Textarea
                  aria-label="MCP 参数"
                  rows={3}
                  className="font-mono text-xs select-text rounded-lg"
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  disabled={busy}
                />
              </FormField>
              <FormField label="环境变量（JSON 字符串键值对象）">
                <Textarea
                  aria-label="MCP 环境变量"
                  rows={4}
                  className="font-mono text-xs select-text rounded-lg"
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                  disabled={busy}
                />
              </FormField>
              {field('工作目录', config.cwd, 'cwd')}
            </>
          )}
          {field('服务说明', config.description, 'description')}
          <p className="text-[11px] text-muted-foreground">可在高级 JSON 中设置超时、回调地址和各工具的暴露方式。</p>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className={settingsControlClassName} type="submit" disabled={busy}>
          保存并检查
        </Button>
        <Button className={settingsControlClassName} type="button" variant="outline" disabled={busy} onClick={onCancel}>
          取消编辑
        </Button>
      </div>
    </form>
  )
}
