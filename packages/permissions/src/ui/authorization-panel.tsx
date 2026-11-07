import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type {
  AuthorizationEffectKind,
  AuthorizationScope,
  AuthorizationSnapshot,
} from '@pi-meme/contracts/authorization'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { SettingsRow } from '@pi-meme/ui/components/settings'

const effectLabels: Record<AuthorizationEffectKind, string> = {
  'fs.read': '读取文件',
  'fs.write': '修改文件',
  'network.read': '网络查询',
  'network.write': '外部写入',
  'process.read': '只读命令',
  'process.write': '执行命令',
  'host.write': '修改服务',
  'policy.write': '修改权限',
  'secret.read': '读取凭据',
  'artifact.write': '保存产物',
}

function scopeLabel(scope: AuthorizationScope) {
  if (scope.sessionId) return `会话 ${scope.sessionId}`
  if (scope.projectId) return `项目 ${scope.projectId}`
  if (scope.clientId) return `客户端 ${scope.clientId}`
  return '此服务'
}

function parseSnapshot(value: unknown): AuthorizationSnapshot {
  if (!value || typeof value !== 'object') throw new Error('权限状态格式无效，请刷新重试')
  const snapshot = value as Partial<AuthorizationSnapshot>
  if (
    !snapshot.scope?.hostId ||
    !Array.isArray(snapshot.approvals) ||
    !Array.isArray(snapshot.leases) ||
    !Array.isArray(snapshot.revocations)
  )
    throw new Error('权限服务版本不匹配，请重新连接')
  return value as AuthorizationSnapshot
}

/** Uses the same authenticated Host RPC transport as the surrounding settings. */
export function AuthorizationPanel({
  bridge,
}: {
  bridge: { rpc: (method: string, args?: unknown[]) => Promise<unknown> }
}) {
  const rpc = bridge.rpc
  const [snapshot, setSnapshot] = useState<AuthorizationSnapshot>()
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [visibleUncertain, setVisibleUncertain] = useState(10)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [confirmation, setConfirmation] = useState<{ scope: AuthorizationScope; action: 'revoke' | 'resume' }>()
  const generation = useRef(0)
  const sequence = useRef(0)
  const activeActions = useRef(new Set<string>())

  const reload = useCallback(
    async (manual = false) => {
      const current = generation.current
      const request = ++sequence.current
      if (manual) setRefreshing(true)
      try {
        const next = parseSnapshot(await rpc('authorization:snapshot', []))
        if (generation.current === current && sequence.current === request) {
          setSnapshot(next)
          setError(undefined)
        }
      } catch (cause) {
        if (generation.current === current && sequence.current === request)
          setError(cause instanceof Error ? cause.message : '读取权限失败')
      } finally {
        if (generation.current === current && sequence.current === request) setRefreshing(false)
      }
    },
    [rpc],
  )

  useEffect(() => {
    generation.current++
    setSnapshot(undefined)
    setError(undefined)
    setPending(new Set())
    setConfirmation(undefined)
    setVisibleUncertain(10)
    activeActions.current.clear()
    void reload()
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    return () => {
      generation.current++
      sequence.current++
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [reload])

  const perform = async (key: string, method: string, args: unknown[]) => {
    if (activeActions.current.has(key)) return
    const current = generation.current
    activeActions.current.add(key)
    setPending((value) => new Set(value).add(key))
    setError(undefined)
    try {
      await rpc(method, args)
      if (generation.current === current) {
        setConfirmation(undefined)
        await reload()
      }
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : '操作失败，请重试')
    } finally {
      if (generation.current === current) {
        activeActions.current.delete(key)
        setPending((value) => {
          const next = new Set(value)
          next.delete(key)
          return next
        })
      }
    }
  }

  const approvals =
    snapshot?.approvals.filter((value) => value.status === 'pending' && value.expiresAt > Date.now()) ?? []
  const running = snapshot?.leases.filter((value) => value.status === 'running' || value.status === 'prepared') ?? []
  const uncertain = snapshot?.leases.filter((value) => value.status === 'outcome-unknown') ?? []
  const scopes = new Map<string, AuthorizationScope>()
  for (const lease of running) scopes.set(JSON.stringify(lease.scope), lease.scope)
  const confirmKey = confirmation ? `${confirmation.action}:${JSON.stringify(confirmation.scope)}` : ''

  return (
    <section aria-label="授权与运行中的操作" aria-busy={!snapshot && !error} className="min-w-0 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4">
        <h3 className="text-xs font-medium">授权与运行中的操作</h3>
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void reload(true)}>
          <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
          {refreshing ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!snapshot ? (
        <p role="status" className="ui-loading-delayed py-3 text-xs text-muted-foreground">
          {error ? '权限状态尚未读取，请重试。' : '正在读取权限…'}
        </p>
      ) : (
        <div className="min-w-0 divide-y divide-border/40">
          <SettingsRow>
            <p className="min-w-0 flex-1">{snapshot.accepting ? '授权服务运行中' : '授权服务正在停止'}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={!snapshot.accepting}
              onClick={() => setConfirmation({ scope: snapshot.scope, action: 'revoke' })}
            >
              暂停新授权并撤权
            </Button>
          </SettingsRow>
          {approvals.length === 0 ? (
            <SettingsRow>
              <p className="text-muted-foreground">暂无待处理审批</p>
            </SettingsRow>
          ) : (
            approvals.map((approval) => (
              <SettingsRow key={approval.id} className="items-start">
                <div className="min-w-0 flex-1 basis-64 space-y-1.5">
                  <p className="break-words font-medium">{approval.operation.summary ?? approval.operation.id}</p>
                  <p className="break-all text-muted-foreground">
                    {scopeLabel(approval.scope)} · {approval.principalId}
                  </p>
                  <ul className="space-y-1">
                    {approval.operation.effects.map((effect, index) => (
                      <li key={`${effect.kind}:${index}`} className="break-all">
                        <span className="text-muted-foreground">{effectLabels[effect.kind]}：</span>
                        {effect.resource}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">有效至 {new Date(approval.expiresAt).toLocaleTimeString()}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending.has(approval.id)}
                    onClick={() =>
                      void perform(approval.id, 'authorization:respond', [
                        approval.id,
                        { decision: 'deny', nonce: approval.nonce },
                      ])
                    }
                  >
                    拒绝
                  </Button>
                  <Button
                    size="sm"
                    disabled={pending.has(approval.id) || !snapshot.accepting || Boolean(error)}
                    onClick={() =>
                      void perform(approval.id, 'authorization:respond', [
                        approval.id,
                        { decision: 'allow-once', nonce: approval.nonce },
                      ])
                    }
                  >
                    {pending.has(approval.id) ? '处理中…' : '允许一次'}
                  </Button>
                </div>
              </SettingsRow>
            ))
          )}
          {[...scopes.entries()].map(([key, scope]) => (
            <SettingsRow key={key}>
              <p className="min-w-0 flex-1 break-all">
                {scopeLabel(scope)} · {running.filter((lease) => JSON.stringify(lease.scope) === key).length} 个操作
              </p>
              <Button variant="outline" size="sm" onClick={() => setConfirmation({ scope, action: 'revoke' })}>
                撤销授权
              </Button>
            </SettingsRow>
          ))}
          {snapshot.revocations.map((revocation) => (
            <SettingsRow key={revocation.id}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="break-all">{scopeLabel(revocation.scope)} · 已撤权</p>
                <p className="break-words text-muted-foreground">{revocation.reason}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmation({ scope: revocation.scope, action: 'resume' })}
              >
                恢复授权入口
              </Button>
            </SettingsRow>
          ))}
          {uncertain.length ? (
            <SettingsRow className="items-start">
              <div className="min-w-0 flex-1 space-y-3">
                <p role="status" className="text-muted-foreground">
                  {uncertain.length} 个操作结果未确认。请先核对目标状态，重复执行可能产生额外效果。
                </p>
                <ul className="space-y-3">
                  {uncertain
                    .slice(-visibleUncertain)
                    .reverse()
                    .map((lease) => (
                      <li key={lease.id} className="min-w-0 space-y-1">
                        <p className="break-all font-mono text-[11px]">{lease.operationId}</p>
                        <p className="break-all text-muted-foreground">
                          {scopeLabel(lease.scope)} · {new Date(lease.finishedAt ?? lease.createdAt).toLocaleString()}
                        </p>
                        {lease.reason ? <p className="break-words text-muted-foreground">{lease.reason}</p> : null}
                      </li>
                    ))}
                </ul>
                {uncertain.length > visibleUncertain ? (
                  <Button variant="ghost" size="sm" onClick={() => setVisibleUncertain((value) => value + 10)}>
                    显示更多
                  </Button>
                ) : null}
              </div>
            </SettingsRow>
          ) : null}
        </div>
      )}
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !pending.has(confirmKey)) setConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogTitle>{confirmation?.action === 'resume' ? '恢复授权入口？' : '撤销此范围的授权？'}</DialogTitle>
          <DialogDescription>
            {confirmation?.action === 'resume'
              ? '恢复后，新操作仍需重新校验权限；不会恢复旧授权或自动重放操作。'
              : '待处理审批和未使用授权将失效，运行中的操作会收到取消信号。已发生的效果无法自动撤回，仍需确认进程清理结果。'}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" disabled={pending.has(confirmKey)} onClick={() => setConfirmation(undefined)}>
              取消
            </Button>
            <Button
              disabled={pending.has(confirmKey)}
              onClick={() => {
                if (confirmation) void perform(confirmKey, `authorization:${confirmation.action}`, [confirmation.scope])
              }}
            >
              {pending.has(confirmKey) ? '处理中…' : confirmation?.action === 'resume' ? '恢复授权入口' : '撤销授权'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
