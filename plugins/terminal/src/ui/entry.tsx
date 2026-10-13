import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import styles from '@xterm/xterm/css/xterm.css'
import type { HostControlEvent, TerminalSnapshot } from '@pi-meme/contracts/app-host'
import type { UiContributionProps, UiPluginContext } from '@pi-meme/plugin-sdk/ui'

export async function activate(context: UiPluginContext) {
  const capabilities = await context.host.capabilities()
  const css = document.createElement('style')
  css.textContent = styles
  document.head.append(css)
  type Output = { terminalId: string; data?: string; outputSequence?: number; exitCode?: number }
  const instances = new Map<string, TerminalSnapshot>()
  const restoring = new Map<string, Output[]>()
  const listeners = new Set<() => void>()
  const outputListeners = new Set<(event: { terminalId: string; data?: string; exitCode?: number }) => void>()
  let revision = 0
  let disposed = false
  const notify = () => {
    revision++
    for (const listener of listeners) listener()
  }
  const unsubscribe = await context.host.events.subscribe({}, (event: HostControlEvent) => {
    if (event.type !== 'terminal' || !('terminalId' in event.value)) return
    const value = event.value as Output
    restoring.get(value.terminalId)?.push(value)
    const instance = [...instances.values()].find((entry) => entry.terminalId === value.terminalId)
    if (!instance) return
    if (value.data && (value.outputSequence ?? 0) > instance.outputSequence) {
      instance.output += value.data
      if (instance.output.length > 256 * 1024) instance.output = instance.output.slice(-256 * 1024)
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
      if (disposed) {
        await context.host.terminal.close(ref, { idempotencyKey: crypto.randomUUID() })
        return
      }
      for (const event of buffered) {
        if (event.data && (event.outputSequence ?? 0) > snapshot.outputSequence) {
          snapshot.output += event.data
          snapshot.outputSequence = event.outputSequence!
        }
        if (event.exitCode !== undefined) {
          snapshot.exited = true
          snapshot.exitCode = event.exitCode
        }
      }
      snapshot.output = snapshot.output.slice(-256 * 1024)
      instances.set(key, snapshot)
      notify()
    } finally {
      if (restoring.get(ref.terminalId) === buffered) restoring.delete(ref.terminalId)
    }
  }
  function Console({ host, instance }: UiContributionProps & { instance: TerminalSnapshot }) {
    const container = useRef<HTMLDivElement>(null)
    const [error, setError] = useState('')
    useEffect(() => {
      if (!container.current) return
      const terminal = new Terminal({
        fontFamily: 'var(--font-code)',
        fontSize: 13,
        theme: { background: '#16202b' },
        convertEol: false,
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(container.current)
      terminal.write(instance.output)
      const output = (event: { terminalId: string; data?: string }) => {
        if (event.terminalId === instance.terminalId && event.data) terminal.write(event.data)
      }
      outputListeners.add(output)
      const input = terminal.onData((data) => {
        void host.terminal
          .input(instance, data, { idempotencyKey: crypto.randomUUID() })
          .catch((cause) => setError(String(cause)))
      })
      const observer = new ResizeObserver(() => {
        fit.fit()
        if (!instance.exited && terminal.cols && terminal.rows)
          void host.terminal
            .resize(instance, { cols: terminal.cols, rows: terminal.rows }, { idempotencyKey: crypto.randomUUID() })
            .catch((cause) => setError(String(cause)))
      })
      observer.observe(container.current)
      terminal.focus()
      return () => {
        observer.disconnect()
        input.dispose()
        outputListeners.delete(output)
        terminal.dispose()
      }
    }, [host, instance])
    return (
      <div style={{ flex: 1, minHeight: 0 }}>
        <div ref={container} style={{ height: '100%', minHeight: 100 }} />
        {error && <p role="alert">{error}</p>}
      </div>
    )
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 8, gap: 8 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13, flexShrink: 0 }}>
          {!instance ? (
            <button
              type="button"
              disabled={busy || !root || !capabilities.features.includes('terminal')}
              onClick={() => void open()}
            >
              {busy ? '正在创建…' : '创建终端'}
            </button>
          ) : (
            <>
              <span
                title={instance.cwd}
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {instance.cwd}
                {instance.exited ? `（已退出 ${instance.exitCode}）` : ''}
              </span>
              <button type="button" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} onClick={() => void attach()}>
                重新连接
              </button>
              <button type="button" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} onClick={() => void close()}>
                关闭终端
              </button>
            </>
          )}
        </div>
        {!capabilities.features.includes('terminal') && <p role="status">所属 Host 的 node-pty 原生模块不可用。</p>}
        {error && <p role="alert">{error}</p>}
        {instance && <Console key={instance.terminalId} {...props} instance={instance} />}
      </div>
    )
  }
  const release = context.panels.register({
    id: `${context.pluginId}:terminal`,
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
    render: (props) => <Panel {...props} />,
  })
  return async () => {
    disposed = true
    release()
    unsubscribe()
    outputListeners.clear()
    listeners.clear()
    css.remove()
    await Promise.allSettled(
      [...instances.values()].map((instance) =>
        context.host.terminal.close(instance, { idempotencyKey: crypto.randomUUID() }),
      ),
    )
    instances.clear()
  }
}
