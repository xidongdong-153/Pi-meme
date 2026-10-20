import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { HostApi, TerminalSnapshot } from '@pi-meme/contracts/app-host'

export type TerminalOutput = { terminalId: string; data?: string; outputSequence?: number; exitCode?: number }

export function TerminalConsole({
  host,
  instance,
  outputListeners,
}: {
  host: HostApi
  instance: TerminalSnapshot
  outputListeners: Set<(event: TerminalOutput) => void>
}) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!container.current) return
    const fit = new FitAddon()
    const webgl = new WebglAddon()
    let disposed = false
    let ready = false
    let restoring = true
    let outputSequence = 0
    let dimensions = { cols: instance.cols, rows: instance.rows }
    let resizing = Promise.resolve()
    const buffered: TerminalOutput[] = []
    const style = () => getComputedStyle(document.documentElement)
    const terminal = new Terminal({
      cols: instance.cols,
      rows: instance.rows,
      fontFamily: style().getPropertyValue('--font-code').trim() || 'monospace',
      fontSize: Number.parseFloat(style().getPropertyValue('--code-size')) || 13,
      allowTransparency: true,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      disableStdin: true,
      convertEol: false,
    })
    const syncSize = () => {
      if (restoring || disposed || !container.current?.clientWidth || !container.current.clientHeight) return
      fit.fit()
      if (instance.exited || (terminal.cols === dimensions.cols && terminal.rows === dimensions.rows)) return
      const next = { cols: terminal.cols, rows: terminal.rows }
      dimensions = next
      resizing = resizing
        .then(async () => {
          if (!disposed) await host.terminal.resize(instance, next, { idempotencyKey: crypto.randomUUID() })
        })
        .catch((cause) => {
          if (!disposed) setError(String(cause))
        })
    }
    const applyTheme = () => {
      const colors = style()
      terminal.options.theme = {
        background: '#00000000',
        foreground: colors.getPropertyValue('--color-text').trim(),
        cursor: colors.getPropertyValue('--color-accent').trim(),
        selectionBackground: colors.getPropertyValue('--color-elevated').trim(),
      }
      terminal.options.fontFamily = colors.getPropertyValue('--font-code').trim() || 'monospace'
      terminal.options.fontSize = Number.parseFloat(colors.getPropertyValue('--code-size')) || 13
    }
    applyTheme()
    const theme = new MutationObserver(() => {
      applyTheme()
      syncSize()
    })
    theme.observe(document.documentElement, { attributes: true })
    terminal.loadAddon(fit)
    const writeOutput = (event: TerminalOutput) => {
      if (event.data && (event.outputSequence ?? 0) > outputSequence) {
        outputSequence = event.outputSequence!
        terminal.write(event.data)
      }
    }
    const output = (event: TerminalOutput) => {
      if (event.terminalId !== instance.terminalId) return
      if (ready) writeOutput(event)
      else buffered.push(event)
    }
    outputListeners.add(output)
    const input = terminal.onData((data) => {
      if (!ready) return
      void host.terminal.input(instance, data, { idempotencyKey: crypto.randomUUID() }).catch((cause) => {
        if (!disposed) setError(String(cause))
      })
    })
    const contextLoss = webgl.onContextLoss(() => {
      webgl.dispose()
      setError('终端图形渲染已失效，当前使用字体渲染。')
    })
    const observer = new ResizeObserver(syncSize)
    observer.observe(container.current)
    setError('')
    void Promise.all([host.terminal.attach(instance), document.fonts.ready])
      .then(([snapshot]) => {
        if (disposed) return
        dimensions = { cols: snapshot.cols, rows: snapshot.rows }
        outputSequence = snapshot.outputSequence
        terminal.resize(snapshot.cols, snapshot.rows)
        terminal.write(snapshot.output, () => {
          if (disposed || !container.current) return
          terminal.open(container.current)
          try {
            terminal.loadAddon(webgl)
          } catch (cause) {
            webgl.dispose()
            setError(`终端图形渲染不可用：${String(cause)}`)
          }
          for (const event of buffered) writeOutput(event)
          buffered.length = 0
          ready = true
          terminal.write('', () => {
            if (disposed) return
            restoring = false
            syncSize()
            terminal.options.disableStdin = false
            terminal.focus()
          })
        })
      })
      .catch((cause) => {
        if (!disposed) {
          outputListeners.delete(output)
          setError(String(cause))
        }
      })
    return () => {
      disposed = true
      observer.disconnect()
      theme.disconnect()
      input.dispose()
      contextLoss.dispose()
      outputListeners.delete(output)
      terminal.dispose()
      webgl.dispose()
    }
  }, [host, instance, outputListeners])
  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div ref={container} className="h-full min-h-24 w-full [&_.xterm-viewport]:bg-transparent!" />
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
