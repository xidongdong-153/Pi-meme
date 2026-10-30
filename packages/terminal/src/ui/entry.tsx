import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from 'react'
import type { HostControlEvent, TerminalSnapshot, WorkspaceRef } from '@pi-meme/contracts/app-host'
import type { UiContributionProps, UiPluginContext } from '@pi-meme/plugin-sdk/ui'
import type { TerminalOutput as Output } from './terminal-console'

const Console = lazy(() => import('./terminal-console').then((module) => ({ default: module.TerminalConsole })))

const opening = new Map<string, Promise<TerminalSnapshot>>()

export async function activate(context: Pick<UiPluginContext, 'host' | 'panels'>) {
  const capabilities = await context.host.capabilities()
  const instances = new Map<string, TerminalSnapshot>()
  const states = new Map<string, { busy: boolean; error: string }>()
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
  async function open(root: WorkspaceRef) {
    const key = JSON.stringify(root)
    if (disposed || states.get(key)?.busy || !capabilities.features.includes('terminal')) return
    const state = { busy: true, error: '' }
    states.set(key, state)
    notify()
    try {
      const previous = instances.get(key)
      if (previous && !previous.exited) {
        await attachInstance(key, previous)
        return
      }
      if (previous) {
        await context.host.terminal.close(previous, { idempotencyKey: crypto.randomUUID() })
        instances.delete(key)
      }
      if (disposed) return
      let pending = opening.get(key)
      if (!pending) {
        pending = (async () => {
          const existing =
            capabilities.features.includes('terminal-list') && context.host.terminal.list
              ? (await context.host.terminal.list(root)).find((item) => !item.exited)
              : undefined
          return existing ?? context.host.terminal.open(root, {}, { idempotencyKey: crypto.randomUUID() })
        })()
        opening.set(key, pending)
        void pending
          .finally(() => {
            if (opening.get(key) === pending) opening.delete(key)
          })
          .catch(() => {})
      }
      const terminal = await pending
      if (disposed) return
      instances.set(key, terminal)
      await attachInstance(key, terminal)
    } catch (cause) {
      state.error = String(cause)
    } finally {
      state.busy = false
      notify()
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
    const state = states.get(key)
    const busy = state?.busy ?? false
    const error = state?.error ?? ''
    const supported = capabilities.features.includes('terminal')
    const started = useRef(false)
    useEffect(() => {
      if (!root || !supported || started.current) return
      started.current = true
      const current = instances.get(key)
      if (!current || current.exited || states.get(key)?.error) void open(root)
    }, [key, root, supported])
    return (
      <section aria-label="终端工具" className="flex h-full min-h-0 flex-col p-3">
        {error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {error}
          </p>
        )}
        {instance ? (
          <div className="flex min-h-0 min-w-0 flex-1">
            <Suspense
              fallback={
                <p role="status" className="text-xs text-muted-foreground">
                  正在加载终端…
                </p>
              }
            >
              <Console
                key={instance.terminalId}
                host={props.host}
                instance={instance}
                outputListeners={outputListeners}
              />
            </Suspense>
          </div>
        ) : (
          <div className="flex-1 text-xs text-muted-foreground">
            {!supported ? (
              <p role="status">当前设备无法启动终端，请检查安装是否完整。</p>
            ) : !root ? (
              <p role="status">选择项目或会话后打开终端。</p>
            ) : busy || (!state && !error) ? (
              <p role="status">正在启动终端…</p>
            ) : null}
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
    instances.clear()
  }
}
