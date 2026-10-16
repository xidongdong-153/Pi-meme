import { useEffect, useState } from 'react'
import { CollapsibleSection } from '@pi-meme/ui/components/ui/collapsible'
import { Settings, RefreshCw, ArrowLeft } from 'lucide-react'
import { IntegrationHeader } from '@pi-meme/ui/components/integration-header'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import type { McpBridge, McpConfigSnapshot, McpDiagnostic, McpServerEntry } from '@pi-meme/contracts/mcp'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { ToolExecutionSettings } from '@pi-meme/contracts/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { ServerForm } from './server-form'
import { object } from '../shared/config'
import { cn } from '@pi-meme/ui/lib/utils'
import {
  BentoSkeletonBar,
  BentoSkeletonCard,
  BentoSkeletonCircle,
  BentoSkeletonPill,
} from '@pi-meme/ui/components/bento-skeleton'

export function McpSettings({
  bridge,
  busy,
  saving,
  mode,
  sessionKey,
  capabilities,
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
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<McpServerEntry | 'new' | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<McpDiagnostic | null>(null)
  const [query, setQuery] = useState('')
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

  async function refresh() {
    if (refreshing || blocked) return
    setRefreshing(true)
    setError('')
    const start = Date.now()
    try {
      setSnapshot(await bridge.getMcpConfig())
    } catch (cause) {
      setError(String(cause))
    } finally {
      const elapsed = Date.now() - start
      if (elapsed < 400) {
        await new Promise((resolve) => setTimeout(resolve, 400 - elapsed))
      }
      setRefreshing(false)
    }
  }
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
  const selected = editing && editing !== 'new' ? editing : undefined
  const servers =
    snapshot?.servers.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  const config = selected && object(selected.config) ? selected.config : {}
  return (
    <section aria-label="MCP 管理" className="space-y-6" aria-busy={blocked}>
      {!editing && (
        <IntegrationHeader
          query={query}
          onQuery={setQuery}
          searchLabel="搜索 MCP 服务器"
          actions={
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="重新加载 MCP 配置"
                disabled={refreshing || blocked}
                onClick={() => void refresh()}
              >
                <RefreshCw className={cn(refreshing && 'animate-spin')} />
              </Button>
              <Button
                disabled={blocked || !snapshot || Boolean(snapshot.error)}
                onClick={() => {
                  setEditing('new')
                  setDeleting(null)
                }}
              >
                新增 MCP 服务
              </Button>
            </>
          }
        />
      )}
      {(snapshot?.error || error) && (
        <p role="alert" className="text-sm text-destructive">
          {snapshot?.error || error}
        </p>
      )}
      {!snapshot ? (
        <BentoSkeletonCard delay={60} className="divide-y divide-border/60 p-0" testId="mcp-skeleton">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center gap-4 p-5">
              <BentoSkeletonCircle className="size-8 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <BentoSkeletonBar className="w-28" size="sm" />
                  <BentoSkeletonBar className="w-16" size="xs" />
                </div>
                <BentoSkeletonBar className="w-64 max-w-full" size="xs" />
              </div>
              <BentoSkeletonPill className="h-6 w-12" />
            </div>
          ))}
        </BentoSkeletonCard>
      ) : editing ? (
        <div className="space-y-5">
          <Button
            variant="ghost"
            disabled={blocked}
            onClick={() => {
              setEditing(null)
              setDeleting(null)
            }}
          >
            <ArrowLeft />
            返回 MCP
          </Button>
          <Button
            variant="outline"
            size="sm"
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
          <h3 className="text-xl font-semibold">{selected?.name ?? '新增 MCP 服务'}</h3>
          {selected?.error && (
            <p role="alert" className="text-sm text-destructive">
              {selected.error}
            </p>
          )}
          {selected && (
            <div className="flex flex-wrap gap-2">
              {typeof config.url === 'string' && (
                <Button
                  variant="outline"
                  disabled={blocked}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(`/mcp login ${selected.name}`)
                      .then(() => setCopied(selected.name))
                      .catch(() => setError('复制失败，请手动复制登录命令'))
                  }}
                >
                  {copied === selected.name ? '已复制登录命令' : `复制 ${selected.name} 登录命令`}
                </Button>
              )}
              <Button variant="outline" disabled={blocked} onClick={() => setDeleting(selected.name)}>
                删除 {selected.name}
              </Button>
            </div>
          )}
          {selected && typeof config.url === 'string' && (
            <p className="text-xs text-muted-foreground">
              在完全权限会话中执行 <code>/mcp login {selected.name}</code> 完成登录。
            </p>
          )}
          {deleting && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <p className="text-sm">删除全局服务 {deleting}？</p>
              <div className="flex gap-2">
                <Button
                  disabled={blocked}
                  onClick={() =>
                    void act(async () => {
                      setSnapshot(await bridge.deleteMcpServer({ name: deleting, revision: snapshot.revision }))
                      setDeleting(null)
                      setEditing(null)
                    })
                  }
                >
                  确认删除 {deleting}
                </Button>
                <Button variant="outline" disabled={blocked} onClick={() => setDeleting(null)}>
                  取消删除
                </Button>
              </div>
            </div>
          )}
          {!snapshot.error && (
            <ServerForm
              key={editing === 'new' ? 'new' : `${editing.name}:${snapshot.revision}`}
              entry={selected}
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
        </div>
      ) : (
        <div className="space-y-4">
          <h3 className="text-sm font-medium">服务器</h3>
          {servers.length ? (
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {servers.map((entry) => {
                const value = object(entry.config) ? entry.config : {}
                const authorizationRequired = capabilities.mcpEnabled === false && value.desktopAuthorized !== true
                return (
                  <div key={entry.name} aria-label={`MCP 服务：${entry.name}`} className="flex items-center gap-4 p-5">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{entry.name}</span>
                      {entry.error && (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          {entry.error}
                        </p>
                      )}
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`设置 MCP 服务：${entry.name}`}
                      disabled={blocked}
                      onClick={() => {
                        setEditing(entry)
                        setDeleting(null)
                      }}
                    >
                      <Settings className="size-4 text-muted-foreground" />
                    </Button>
                    <Switch
                      label={`启用 MCP 服务：${entry.name}`}
                      checked={value.enabled !== false && !authorizationRequired}
                      disabled={blocked || Boolean(entry.error) || Boolean(snapshot.error)}
                      onChange={(enabled) =>
                        void act(async () => {
                          setSnapshot(
                            await bridge.saveMcpServer({
                              revision: snapshot.revision,
                              name: entry.name,
                              previousName: entry.name,
                              config: { ...value, enabled },
                            }),
                          )
                        })
                      }
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {query ? '没有匹配的 MCP 服务。' : '尚未配置 MCP 服务。'}
            </p>
          )}
        </div>
      )}
      {capabilities.mcpEnabled === false && (
        <p role="status" className="text-xs text-muted-foreground">
          原配置关闭了 MCP；逐个启用需要连接的服务。
        </p>
      )}
      {mode !== 'full-access' && (
        <p role="status" className="text-xs text-muted-foreground">
          当前权限不加载 MCP；切换到完全权限后可使用。
        </p>
      )}
      <CollapsibleSection title="连接诊断" description="检查已配置服务，查看诊断输出">
        <div className="space-y-4 text-muted-foreground">
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
          <p className="text-xs">检查会在独立目录启动配置中的服务，不启动聊天。相对工作目录按诊断目录解析。</p>
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
      </CollapsibleSection>
      {working && (
        <p role="status" className="text-xs text-muted-foreground">
          正在处理 MCP 操作…
        </p>
      )}
    </section>
  )
}
