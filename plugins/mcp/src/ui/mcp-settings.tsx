import { useEffect, useState } from 'react'
import type { McpBridge, McpConfigSnapshot, McpDiagnostic, McpServerEntry } from '@pi-meme/contracts/mcp'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { ServerForm } from './server-form'
import { object } from '../shared/config'

export function McpSettings({
  bridge,
  busy,
  saving,
  mode,
  sessionKey,
  capabilities,
  onCapabilities,
}: {
  bridge: McpBridge
  busy: boolean
  saving: boolean
  mode?: AgentAccessMode
  sessionKey?: string
  capabilities: ToolExecutionSettings
  onCapabilities: (value: ToolExecutionSettings) => void
}) {
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [editing, setEditing] = useState<McpServerEntry | 'new' | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<McpDiagnostic | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    bridge
      .getMcpConfig()
      .then((value) => {
        if (active) setSnapshot(value)
      })
      .catch((cause) => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [bridge])
  const blocked = busy || saving || working
  const act = async (work: () => Promise<void>) => {
    if (blocked) return
    setWorking(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      setError(String(cause))
      // 保存成功而重连失败时，仍读取已落盘的配置，避免再次用旧 revision 保存。
      if (String(cause).includes('配置已保存')) {
        try {
          setSnapshot(await bridge.getMcpConfig())
          setEditing(null)
        } catch {
          /* 保留操作错误。 */
        }
      }
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="在 Desktop 中启用 MCP"
          checked={capabilities.mcpEnabled}
          disabled={blocked}
          onChange={(event) =>
            onCapabilities({
              codemodeEnabled: capabilities.codemodeEnabled || event.target.checked,
              mcpEnabled: event.target.checked,
            })
          }
        />
        在 Desktop 中启用 MCP
      </label>
      <p role="status" className="text-sm text-muted-foreground">
        {mode === 'full-access'
          ? '当前为完全权限，开启后会连接已启用的 MCP 服务。'
          : '当前权限不加载 MCP；切换到完全权限后可使用。'}{' '}
        开启 MCP 会同时开启 codemode。
      </p>
      <p className="text-xs text-muted-foreground">
        Desktop 全局配置保存在应用数据目录。项目 <code>.pi/mcp.json</code> 只读；Desktop 工作区覆盖项优先级最高。
      </p>
      {snapshot && <p className="break-all font-mono text-xs text-muted-foreground select-text">{snapshot.path}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={blocked || !snapshot || Boolean(snapshot.error)}
          onClick={() => {
            setEditing('new')
            setDeleting(null)
          }}
        >
          新增 MCP 服务
        </Button>
        <Button
          variant="outline"
          disabled={blocked}
          onClick={() =>
            void act(async () => {
              setSnapshot(await bridge.getMcpConfig())
              setEditing(null)
              setDeleting(null)
            })
          }
        >
          重新加载配置
        </Button>
        <Button
          variant="outline"
          disabled={blocked || mode !== 'full-access' || !sessionKey || !snapshot || Boolean(snapshot.error)}
          onClick={() =>
            void act(async () => {
              setDiagnostic(await bridge.checkMcpServers(sessionKey!))
            })
          }
        >
          检查全部全局服务
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        检查会启动配置中的服务，在独立目录运行，不启动聊天。相对工作目录按该诊断目录解析。
      </p>
      {snapshot?.error && (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!snapshot ? (
        <p role="status">正在读取 MCP 配置…</p>
      ) : (
        <>
          {!snapshot.servers.length && !snapshot.error && (
            <p className="text-sm text-muted-foreground">尚未配置 Desktop 全局 MCP 服务。</p>
          )}
          {snapshot.servers.map((entry) => {
            const config = object(entry.config) ? entry.config : {}
            const http = typeof config.url === 'string'
            return (
              <section
                key={entry.name}
                aria-label={`MCP 服务：${entry.name}`}
                className="space-y-3 rounded-xl border border-border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{entry.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {http ? 'HTTP' : typeof config.command === 'string' ? 'stdio' : '配置无效'} ·{' '}
                    {config.enabled === false ? '已禁用' : '已启用'}
                  </span>
                </div>
                {entry.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {entry.error}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={blocked}
                    onClick={() => {
                      setEditing(entry)
                      setDeleting(null)
                    }}
                  >
                    编辑 {entry.name}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={blocked || Boolean(entry.error)}
                    onClick={() =>
                      void act(async () => {
                        setSnapshot(
                          await bridge.saveMcpServer({
                            revision: snapshot.revision,
                            name: entry.name,
                            previousName: entry.name,
                            config: { ...config, enabled: config.enabled === false },
                          }),
                        )
                      })
                    }
                  >
                    {config.enabled === false ? '启用' : '禁用'} {entry.name}
                  </Button>
                  <Button size="sm" variant="outline" disabled={blocked} onClick={() => setDeleting(entry.name)}>
                    删除 {entry.name}
                  </Button>
                  {http && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={blocked}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(`/mcp login ${entry.name}`)
                          .then(() => setCopied(entry.name))
                          .catch(() => setError('复制失败，请手动复制登录命令'))
                      }}
                    >
                      {copied === entry.name ? '已复制登录命令' : `复制 ${entry.name} 登录命令`}
                    </Button>
                  )}
                </div>
                {http && (
                  <p className="break-all text-xs text-muted-foreground select-text">
                    需要登录的服务，在会话中执行 <code>/mcp login {entry.name}</code> 完成授权；必须先开启工具执行里的
                    MCP 开关。
                  </p>
                )}
                {deleting === entry.name && (
                  <div className="space-y-2">
                    <p className="text-sm">删除全局服务 {entry.name}？</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={blocked}
                        onClick={() =>
                          void act(async () => {
                            setSnapshot(await bridge.deleteMcpServer({ name: entry.name, revision: snapshot.revision }))
                            setDeleting(null)
                          })
                        }
                      >
                        确认删除 {entry.name}
                      </Button>
                      <Button size="sm" variant="outline" disabled={blocked} onClick={() => setDeleting(null)}>
                        取消删除
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )
          })}
          {editing && !snapshot.error && (
            <ServerForm
              key={editing === 'new' ? 'new' : `${editing.name}:${snapshot.revision}`}
              entry={editing === 'new' ? undefined : editing}
              revision={snapshot.revision}
              busy={blocked}
              onCancel={() => setEditing(null)}
              onSave={async (input) => {
                await act(async () => {
                  setSnapshot(await bridge.saveMcpServer(input))
                  setEditing(null)
                })
              }}
            />
          )}
        </>
      )}
      {working && (
        <p role="status" className="text-sm text-muted-foreground">
          正在处理 MCP 操作…
        </p>
      )}
      {diagnostic && (
        <section aria-label="MCP 诊断结果" className="space-y-2">
          <p className="text-sm">
            检查时间：{new Date(diagnostic.checkedAt).toLocaleString()} ·{' '}
            {diagnostic.timedOut
              ? '检查超时'
              : diagnostic.exitCode === 0
                ? '检查完成'
                : `检查失败（退出码 ${String(diagnostic.exitCode)}）`}
          </p>
          <p className="text-xs text-muted-foreground">
            这是本次 Desktop 全局配置诊断结果，不代表当前聊天的实时连接状态。
          </p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border p-3 text-xs select-text">
            {diagnostic.output || 'Pi 未返回诊断输出'}
          </pre>
        </section>
      )}
    </div>
  )
}
