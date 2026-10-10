import { useState } from 'react'
import type { McpServerEntry, SaveMcpServer } from '@pi-meme/contracts/mcp'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Textarea } from '@pi-meme/ui/components/ui/textarea'
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
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState(() => stringify(initial, {}))
  const [error, setError] = useState('')
  const http = 'url' in config || !('command' in config)
  const compose = () => {
    const next = { ...config }
    if (http) next.headers = JSON.parse(headers)
    else {
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
  const field = (label: string, value: unknown, key: string) => (
    <label className="block space-y-1.5">
      <span className="text-sm">{label}</span>
      <Input
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setConfig({ ...config, [key]: event.target.value })}
        disabled={busy}
      />
    </label>
  )
  return (
    <form
      aria-label="MCP 服务编辑"
      className="space-y-4 rounded-xl border border-border p-4"
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
      <label className="block space-y-1.5">
        <span className="text-sm">服务名称</span>
        <Input
          aria-label="MCP 服务名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </label>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={changeMode}>
        {advanced ? '切换到表单' : '编辑高级 JSON'}
      </Button>
      {advanced ? (
        <label className="block space-y-1.5">
          <span className="text-sm">单个服务的原生 JSON</span>
          <Textarea
            aria-label="MCP 高级 JSON"
            className="font-mono text-xs select-text"
            rows={14}
            value={json}
            onChange={(event) => setJson(event.target.value)}
            disabled={busy}
          />
        </label>
      ) : (
        <>
          <label className="block space-y-1.5">
            <span className="text-sm">连接类型</span>
            <select
              aria-label="MCP 连接类型"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={http ? 'http' : 'stdio'}
              disabled={busy}
              onChange={(event) => {
                const next = { ...config }
                if (event.target.value === 'http') {
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
              <option value="http">HTTP</option>
              <option value="stdio">stdio 本地进程</option>
            </select>
          </label>
          {http ? (
            <>
              {field('MCP URL', config.url, 'url')}
              <label className="block space-y-1.5">
                <span className="text-sm">Headers（JSON 字符串键值对象）</span>
                <Textarea
                  aria-label="MCP Headers"
                  rows={4}
                  className="font-mono text-xs select-text"
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  disabled={busy}
                />
              </label>
            </>
          ) : (
            <>
              {field('可执行命令', config.command, 'command')}
              <p className="text-xs text-muted-foreground">
                命令填写单个可执行文件，参数填入下方数组，不拼接 Shell 命令。
              </p>
              <label className="block space-y-1.5">
                <span className="text-sm">参数（JSON 字符串数组）</span>
                <Textarea
                  aria-label="MCP 参数"
                  rows={3}
                  className="font-mono text-xs select-text"
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm">环境变量（JSON 字符串键值对象）</span>
                <Textarea
                  aria-label="MCP 环境变量"
                  rows={4}
                  className="font-mono text-xs select-text"
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                  disabled={busy}
                />
              </label>
              {field('工作目录', config.cwd, 'cwd')}
            </>
          )}
          {field('服务说明', config.description, 'description')}
          <p className="text-xs text-muted-foreground">
            OAuth、超时和工具暴露方式在高级 JSON 中编辑；其他原生字段会保留。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          保存服务
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          取消编辑
        </Button>
      </div>
    </form>
  )
}
