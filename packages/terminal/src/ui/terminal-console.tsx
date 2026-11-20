import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { HostApi, TerminalSnapshot } from '@pi-meme/contracts/app-host'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'
import { watchTerminalAppearance } from './terminal-appearance'
import { attachTerminalLinks, type TerminalLinkHint } from './terminal-links'

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
  const [loading, setLoading] = useState(true)
  const [linkHint, setLinkHint] = useState<TerminalLinkHint | null>(null)
  useEffect(() => {
    if (!container.current) return
    const fit = new FitAddon()
    let appearance: MutationObserver | undefined
    let disposed = false
    let ready = false
    let restoring = true
    let outputSequence = 0
    let dimensions = { cols: instance.cols, rows: instance.rows }
    let resizing = Promise.resolve()
    const buffered: TerminalOutput[] = []
    const terminal = new Terminal({
      cols: instance.cols,
      rows: instance.rows,
      lineHeight: 1.15,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 4.5,
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
    terminal.loadAddon(fit)
    const detachLinks = attachTerminalLinks(terminal, container.current, setLinkHint)
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
      if (!ready || instance.exited || !container.current?.clientWidth || container.current.closest('[inert]')) return
      void host.terminal.input(instance, data, { idempotencyKey: crypto.randomUUID() }).catch((cause) => {
        if (!disposed) setError(String(cause))
      })
    })
    const observer = new ResizeObserver(syncSize)
    observer.observe(container.current)
    setError('')
    setLoading(true)
    void Promise.all([host.terminal.attach(instance), document.fonts.ready])
      .then(([snapshot]) => {
        if (disposed) return
        dimensions = { cols: snapshot.cols, rows: snapshot.rows }
        outputSequence = snapshot.outputSequence
        terminal.resize(snapshot.cols, snapshot.rows)
        terminal.write(snapshot.output, () => {
          if (disposed || !container.current) return
          terminal.open(container.current)
          appearance = watchTerminalAppearance(terminal, syncSize)
          for (const event of buffered) writeOutput(event)
          buffered.length = 0
          ready = true
          terminal.write('', () => {
            if (disposed) return
            restoring = false
            syncSize()
            terminal.options.disableStdin = snapshot.exited
            setLoading(false)
            if (container.current?.clientWidth && !container.current.closest('[inert]')) terminal.focus()
          })
        })
      })
      .catch((cause) => {
        if (!disposed) {
          outputListeners.delete(output)
          setLoading(false)
          setError(String(cause))
        }
      })
    return () => {
      disposed = true
      observer.disconnect()
      appearance?.disconnect()
      input.dispose()
      detachLinks()
      outputListeners.delete(output)
      terminal.dispose()
    }
  }, [host, instance, outputListeners])
  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={container}
        className="h-full min-h-24 w-full [&_:is(.xterm-viewport,.xterm-scrollable-element)]:bg-transparent!"
      />
      {linkHint && (
        <Tooltip open onOpenChange={(open) => !open && setLinkHint(null)} disableHoverableContent>
          <TooltipTrigger asChild>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-px"
              style={{ left: linkHint.left, top: linkHint.top }}
            />
          </TooltipTrigger>
          <TooltipContent sideOffset={10} hideWhenDetached>
            打开链接（{linkHint.shortcut} + 单击）
            {linkHint.destination && <span className="block break-all">{linkHint.destination}</span>}
          </TooltipContent>
        </Tooltip>
      )}
      {loading && (
        <p role="status" className="absolute left-0 top-0 text-xs text-muted-foreground">
          正在连接终端…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
