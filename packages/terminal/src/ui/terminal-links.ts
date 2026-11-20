import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Terminal } from '@xterm/xterm'

export type TerminalLinkHint = { left: number; top: number; shortcut: string; destination?: string }

export function attachTerminalLinks(
  terminal: Terminal,
  container: HTMLElement,
  setHint: (hint: TerminalLinkHint | null) => void,
) {
  const mac = /Mac|Darwin|iPhone|iPad|iPod/i.test(navigator.userAgent)
  const shortcut = mac ? 'Cmd' : 'Ctrl'
  let timer: number | undefined
  const hide = () => {
    if (timer === undefined) return
    window.clearTimeout(timer)
    timer = undefined
    setHint(null)
  }
  const hover = (event: MouseEvent, destination?: string) => {
    window.clearTimeout(timer)
    if (event.buttons) return
    const bounds = container.getBoundingClientRect()
    const left = event.clientX - bounds.left
    const top = event.clientY - bounds.top
    timer = window.setTimeout(setHint, 350, { left, top, shortcut, destination })
  }
  const activate = (event: MouseEvent, uri: string) => {
    if (event.button !== 0 || !(mac ? event.metaKey : event.ctrlKey) || terminal.hasSelection()) return
    if (!/^https?:\/\//i.test(uri)) return
    window.open(uri, '_blank', 'noopener,noreferrer')
  }

  terminal.options.linkHandler = { activate, hover, leave: hide }
  terminal.loadAddon(new WebLinksAddon(activate, { hover: (event) => hover(event), leave: hide }))
  const scroll = terminal.onScroll(hide)
  return () => {
    scroll.dispose()
    hide()
  }
}
