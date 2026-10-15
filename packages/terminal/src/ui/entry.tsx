import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Play, RefreshCw, Square, TerminalSquare } from 'lucide-react'
import type { HostControlEvent, TerminalSnapshot } from '@pi-meme/contracts/app-host'
import type { UiContributionProps, UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import type { TerminalOutput as Output } from './terminal-console'

const Console = lazy(() => import('./terminal-console').then((module) => ({ default: module.TerminalConsole })))

export async function activate(context: Pick<UiPluginContext, 'host' | 'panels'>) {
  const capabilities = await context.host.capabilities()
  const instances = new Map<string, TerminalSnapshot>()
  const restoring = new Map<string, Output[]>()
  const listeners = new Set<() => void>()
  const outputListeners = new Set<(event: Output) => void>()
  let revision = 0
  let disposed = false
  const notify = () => {
    revision++
    for (const listener of listeners) listener()
  }
  const unsubscribe = await context.host.events.subscribe({}, (event: HostControlEvent) => {
    if (event.type === 'resync') {
      for (const [key, instance] of instances) void attachInstance(key, instance).catch(() => {})
      return
    }
    if (event.type !== 'terminal' || !('terminalId' in event.value)) return
    const value = event.value as Output
    restoring.get(value.terminalId)?.push(value)
    const instance = [...instances.values()].find((entry) => entry.terminalId === value.terminalId)
    if (!instance) return
    if (value.data && (value.outputSequence ?? 0) > instance.outputSequence) {
      instance.outputSequence = value.outputSequence ?? instance.outputSequence + 1
      for (const listener of outputListeners) listener(value)
    }
    if (value.exitCode !== undefined) {
      instance.exited = true
      instance.exitCode = value.exitCode
      notify()
    }
  })
  async function attachInstance(key: string, ref: TerminalSnapshot) {
    const buffered: Output[] = []
    restoring.set(ref.terminalId, buffered)
    try {
      const snapshot = await context.host.terminal.attach(ref)
      if (disposed || instances.get(key)?.terminalId !== ref.terminalId) {
        if (disposed) await context.host.terminal.close(ref, { idempotencyKey: crypto.randomUUID() })
        return
      }
      for (const event of buffered) {
        if (event.data && (event.outputSequence ?? 0) > snapshot.outputSequence) {
          snapshot.outputSequence = event.outputSequence!
        }
        if (event.exitCode !== undefined) {
          snapshot.exited = true
          snapshot.exitCode = event.exitCode
        }
      }
      instances.set(key, snapshot)
      notify()
    } finally {
      if (restoring.get(ref.terminalId) === buffered) restoring.delete(ref.terminalId)
    }
  }
  function Panel(props: UiContributionProps) {
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      () => revision,
    )
    const root = props.target.session ?? props.target.project
    const key = JSON.stringify(root)
    const instance = instances.get(key)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    async function open() {
      if (!root) return
      setBusy(true)
      setError('')
      try {
        const terminal = await props.host.terminal.open(root, {}, { idempotencyKey: crypto.randomUUID() })
        if (disposed) {
          await props.host.terminal.close(terminal, { idempotencyKey: crypto.randomUUID() })
          return
        }
        instances.set(key, terminal)
        await attachInstance(key, terminal)
      } catch (cause) {
        setError(String(cause))
      } finally {
        setBusy(false)
      }
    }
    async function attach() {
      if (!instance || restoring.has(instance.terminalId)) return
      try {
        await attachInstance(key, instance)
      } catch (cause) {
        setError(String(cause))
      }
    }
    async function close() {
      if (!instance) return
      try {
        await props.host.terminal.close(instance, { idempotencyKey: crypto.randomUUID() })
        instances.delete(key)
        notify()
      } catch (cause) {
        setError(String(cause))
      }
    }
    return (
      <section aria-label="终端工具" className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-xs">
          {instance ? (
            <>
              <span title={instance.cwd} className="min-w-0 flex-1 truncate text-muted-foreground">
                {instance.cwd}
                {instance.exited ? `（已退出 ${instance.exitCode}）` : ''}
              </span>
              <Button variant="ghost" size="icon-sm" aria-label="重新连接终端" onClick={() => void attach()}>
                <RefreshCw className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="关闭终端实例" onClick={() => void close()}>
                <Square className="size-3.5" />
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">当前会话终端</span>
          )}
        </div>
        {error && (
          <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {instance ? (
          <div className="flex min-h-0 min-w-0 flex-1 p-3">
            <Suspense fallback={<p role="status">正在加载终端…</p>}>
              <Console
                key={instance.terminalId}
                host={props.host}
                instance={instance}
                outputListeners={outputListeners}
              />
            </Suspense>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <TerminalSquare className="size-8 text-muted-foreground" strokeWidth={1.3} />
            <p className="text-xs text-muted-foreground">
              {!capabilities.features.includes('terminal')
                ? '所属 Host 的 node-pty 原生模块不可用。'
                : '在当前会话目录中启动 shell。关闭面板会保留终端。'}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !root || !capabilities.features.includes('terminal')}
              onClick={() => void open()}
            >
              <Play className="size-3.5" />
              {busy ? '正在创建…' : '创建终端'}
            </Button>
          </div>
        )}
      </section>
    )
  }

  const release = context.panels.register({
    id: 'builtin:terminal',
    title: '终端',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3 M13 15h4" />
      </svg>
    ),
    location: 'right',
    scope: 'session',
    render: (props) => <Panel key={JSON.stringify(props.target.session ?? props.target.project)} {...props} />,
  })
  return async () => {
    disposed = true
    release()
    unsubscribe()
    outputListeners.clear()
    listeners.clear()
    await Promise.allSettled(
      [...instances.values()].map((instance) =>
        context.host.terminal.close(instance, { idempotencyKey: crypto.randomUUID() }),
      ),
    )
    instances.clear()
  }
}
