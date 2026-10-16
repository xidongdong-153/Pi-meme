import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsBridge } from '@pi-meme/contracts/desktop'
import type { DesktopStorageInfo, HostStorageInfo, StorageTarget } from '@pi-meme/contracts/storage'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'

function size(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = bytes > 0 ? Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))) : 0
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(bytes / 1024 ** index)} ${units[index]}`
}
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const storageCache = new WeakMap<object, { info: HostStorageInfo; desktop: DesktopStorageInfo | null }>()

export function clearStorageCache(bridge?: object) {
  if (bridge) storageCache.delete(bridge)
}

export function StorageSettings({
  bridge,
  onBeforeRestart,
  onMaintaining,
}: {
  bridge: Pick<SettingsBridge, 'getStorageInfo' | 'storage'>
  onBeforeRestart: () => Promise<void>
  onMaintaining: (value: boolean) => void
}) {
  const cached = storageCache.get(bridge)
  const [info, setInfo] = useState<HostStorageInfo | null>(() => cached?.info ?? null)
  const [desktop, setDesktop] = useState<DesktopStorageInfo | null>(() => cached?.desktop ?? null)
  const [loading, setLoading] = useState(() => !cached)
  const [action, setAction] = useState<'choose' | 'open' | 'restart' | null>(null)
  const [target, setTarget] = useState<StorageTarget | null>(null)
  const [confirmation, setConfirmation] = useState<'migrate' | 'cache' | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const operation = useRef(false)
  const revision = useRef(0)
  const load = useCallback(async () => {
    const current = ++revision.current
    setLoading(true)
    setError('')
    try {
      const host = await bridge.getStorageInfo()
      const native = bridge.storage ? await bridge.storage.getInfo(host.hostId) : null
      if (mounted.current && current === revision.current) {
        storageCache.set(bridge, { info: host, desktop: native })
        setInfo(host)
        setDesktop(native)
      }
    } catch (cause) {
      if (mounted.current && current === revision.current) setError(message(cause))
    } finally {
      if (mounted.current && current === revision.current) setLoading(false)
    }
  }, [bridge])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      revision.current++
    }
  }, [load])
  const managed = Boolean(bridge.storage && desktop?.canMaintain)
  const disabled = loading || Boolean(action) || !managed
  async function choose() {
    if (!info || !bridge.storage || disabled || operation.current) return
    operation.current = true
    setAction('choose')
    setError('')
    try {
      const next = await bridge.storage.chooseTarget(info.hostId)
      if (mounted.current && next) {
        setTarget(next)
        setConfirmation('migrate')
      }
    } catch (cause) {
      if (mounted.current) setError(message(cause))
    } finally {
      operation.current = false
      if (mounted.current) setAction(null)
    }
  }
  async function openDirectory(path: string) {
    if (!info || !bridge.storage || operation.current) return
    operation.current = true
    setAction('open')
    setError('')
    try {
      await bridge.storage.openDirectory({ expectedHostId: info.hostId, path })
    } catch (cause) {
      if (mounted.current) setError(message(cause))
    } finally {
      operation.current = false
      if (mounted.current) setAction(null)
    }
  }
  async function confirm() {
    if (!info || !bridge.storage || disabled || !confirmation || operation.current) return
    operation.current = true
    setAction('restart')
    setError('')
    let maintaining = false
    try {
      await onBeforeRestart()
      onMaintaining(true)
      maintaining = true
      storageCache.delete(bridge)
      if (confirmation === 'migrate' && target)
        await bridge.storage.migrate({ expectedHostId: info.hostId, selectionId: target.selectionId })
      else if (confirmation === 'cache') await bridge.storage.clearCache(info.hostId)
      if (mounted.current) {
        setConfirmation(null)
        setTarget(null)
      }
    } catch (cause) {
      if (mounted.current) setError(message(cause))
    } finally {
      operation.current = false
      if (maintaining) onMaintaining(false)
      if (mounted.current) setAction(null)
    }
  }
  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-label="存储设置">
        <h3 className="text-sm font-medium">存储</h3>
        <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <h4 className="text-sm font-medium">应用数据目录</h4>
              {info ? (
                <p className="break-all font-mono text-xs" data-testid="storage-root">
                  {info.dataRoot}
                </p>
              ) : loading ? (
                <div className="flex h-4 items-center" data-testid="storage-skeleton-root">
                  <div className="h-3 w-56 max-w-full animate-pulse rounded bg-muted/80" />
                  <span className="sr-only">正在读取存储信息…</span>
                </div>
              ) : (
                <p role="status" className="text-xs text-muted-foreground">
                  存储信息不可用
                </p>
              )}
              {desktop ? (
                <p className="text-xs text-muted-foreground">
                  {desktop.maintenanceDisabledReason ?? (desktop.source === 'custom' ? '自定义目录' : '默认目录')}
                </p>
              ) : loading ? (
                <div className="flex h-4 items-center" data-testid="storage-skeleton-status">
                  <div className="h-3 w-20 animate-pulse rounded bg-muted/50" />
                </div>
              ) : null}
            </div>
            {bridge.storage && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!info || Boolean(action)}
                  onClick={() => info && void openDirectory(info.dataRoot)}
                >
                  打开目录
                </Button>
                <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void choose()}>
                  {action === 'choose' ? '正在检查…' : '更改目录'}
                </Button>
              </div>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            保存会话、设置、模型凭据、技能、插件和应用创建的工作目录。不会移动外部项目目录。
          </p>
          {!bridge.storage && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              此目录位于所连接的 Host。Web 和远程服务只读展示；请在 Host 启动环境中设置 PI_MEME_DATA_ROOT 后重启服务。
            </p>
          )}
          {!loading && !info && (
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试读取
            </Button>
          )}
        </div>
      </section>
      {bridge.storage && (
        <section className="space-y-3" aria-label="缓存设置">
          <h3 className="text-sm font-medium">缓存</h3>
          <div className="space-y-3 rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-2">
                <h4 className="text-sm font-medium">可清理缓存</h4>
                <p role="status" className="text-xs text-muted-foreground">
                  {loading && !desktop
                    ? '正在统计…'
                    : desktop?.cacheBytes == null
                      ? '占用统计不可用'
                      : size(desktop.cacheBytes)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={loading || Boolean(action)} onClick={() => void load()}>
                  刷新
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled || desktop?.cacheBytes == null || desktop.cacheBytes === 0}
                  onClick={() => setConfirmation('cache')}
                >
                  清理缓存
                </Button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              仅清理会话索引、本机远程摘要和桌面
              HTTP、代码及图形缓存。不会删除会话、凭据、技能、插件或项目文件；历史技能快照与请求去重记录保留。
            </p>
            {desktop?.cacheError && (
              <p role="alert" className="break-words text-xs text-destructive">
                {desktop.cacheError}
              </p>
            )}
          </div>
        </section>
      )}
      {desktop && desktop.backupPaths.length > 0 && (
        <section className="space-y-3" aria-label="迁移备份">
          <h3 className="text-sm font-medium">迁移备份</h3>
          <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              原目录保留了会话和凭据，不会被缓存清理删除。旧 Worktree 副本仅作文件备份，不再作为活动 Worktree 使用。
            </p>
            {desktop.backupPaths.map((path) => (
              <div key={path} className="flex items-center justify-between gap-4">
                <p className="min-w-0 break-all font-mono text-xs">{path}</p>
                <Button variant="outline" size="sm" disabled={Boolean(action)} onClick={() => void openDirectory(path)}>
                  打开备份
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      {desktop?.lastError && (
        <p role="alert" className="break-words text-sm text-destructive">
          上次维护未完成：{desktop.lastError}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && action !== 'restart') {
            setConfirmation(null)
            setTarget(null)
          }
        }}
      >
        <DialogContent>
          <DialogTitle>{confirmation === 'migrate' ? '迁移应用数据目录？' : '清理缓存并重启？'}</DialogTitle>
          <DialogDescription>
            {confirmation === 'migrate'
              ? '应用正常退出后复制数据，校验并修复关联后才切换目录。原目录保留备份，外部项目不移动，应用创建的 Worktree 随数据迁移。'
              : '仅清理可重新生成的缓存，然后重启应用。会话、模型凭据、技能、插件和项目文件不会删除。缓存可能在重启后重新生成。'}
          </DialogDescription>
          {confirmation === 'migrate' && target && (
            <dl className="space-y-2 text-xs">
              <dt className="text-muted-foreground">当前目录</dt>
              <dd className="break-all font-mono">{info?.dataRoot}</dd>
              <dt className="text-muted-foreground">新目录</dt>
              <dd className="break-all font-mono">{target.path}</dd>
              <dt className="text-muted-foreground">复制大小 / 目标可用空间</dt>
              <dd>
                {size(target.bytes)} / {size(target.availableBytes)}
              </dd>
            </dl>
          )}
          {confirmation === 'cache' && desktop?.cacheBytes != null && (
            <p className="text-sm">当前可清理：{size(desktop.cacheBytes)}</p>
          )}
          <p className="text-xs text-muted-foreground">
            请先处理未发送的草稿、附件和未保存的文件，并结束本机任务及终端。重启会关闭当前桌面页面，并断开共享此 Host
            的其他客户端。
          </p>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={action === 'restart'}
              onClick={() => {
                setConfirmation(null)
                setTarget(null)
              }}
            >
              取消
            </Button>
            <Button disabled={disabled} onClick={() => void confirm()}>
              {action === 'restart' ? '正在准备重启…' : confirmation === 'migrate' ? '迁移并重启' : '清理并重启'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
