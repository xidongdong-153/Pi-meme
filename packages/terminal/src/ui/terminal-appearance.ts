import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

export function watchTerminalAppearance(terminal: Terminal, fit: () => void) {
  const root = document.documentElement
  let webgl: WebglAddon | undefined
  let webglUnavailable = false

  function apply() {
    const styles = getComputedStyle(root)
    const token = (name: string) => styles.getPropertyValue(name).trim()
    const light = styles.colorScheme === 'light'
    const background = token('--color-background')
    const accent = token('--color-accent')
    const backdrop = root.dataset.themeBackground === 'app' || root.dataset.themeBackground === 'workspace'
    terminal.options = {
      fontFamily: token('--font-code') || 'monospace',
      fontSize: Number.parseFloat(token('--code-size')) || 13,
      fontWeight: token('--font-code-weight') === '700' ? 'bold' : 'normal',
      theme: {
        background,
        foreground: token('--color-text'),
        cursor: accent,
        cursorAccent: background,
        selectionBackground: `${accent}66`,
        black: light ? '#343642' : '#363946',
        red: light ? '#b52649' : '#f38ba8',
        green: light ? '#367535' : '#a6e3a1',
        yellow: light ? '#895c13' : '#f9e2af',
        blue: light ? '#285bbb' : '#89b4fa',
        magenta: light ? '#803fa5' : '#cba6f7',
        cyan: light ? '#14747b' : '#94e2d5',
        white: light ? '#b9bcc5' : '#bac2de',
        brightBlack: token('--color-muted'),
        brightRed: light ? '#cf365e' : '#ffa5bd',
        brightGreen: light ? '#40843d' : '#bef2b9',
        brightYellow: light ? '#986b1d' : '#ffedc4',
        brightBlue: light ? '#366bd1' : '#a6c8ff',
        brightMagenta: light ? '#944bbd' : '#dfbaff',
        brightCyan: light ? '#16848c' : '#adf0e5',
        brightWhite: light ? '#eff1f5' : '#e6e9f5',
      },
    }

    // WebGL 0.19 fills dim cells with an opaque background. DOM rows let the panel's image show through.
    if (backdrop) {
      webgl?.dispose()
      webgl = undefined
    } else if (!webgl && !webglUnavailable) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webglUnavailable = true
          webgl?.dispose()
          webgl = undefined
          fit()
        })
        terminal.loadAddon(webgl)
      } catch {
        webglUnavailable = true
        webgl?.dispose()
        webgl = undefined
      }
    }
    fit()
  }

  apply()
  const observer = new MutationObserver(apply)
  observer.observe(root, { attributeFilter: ['style', 'data-theme-background'] })
  return observer
}
