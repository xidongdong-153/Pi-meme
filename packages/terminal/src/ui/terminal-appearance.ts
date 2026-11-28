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
        black: light ? '#2c322f' : '#272b30',
        red: light ? '#b9313d' : '#d4727a',
        green: light ? '#23734d' : '#5fa87f',
        yellow: light ? '#9a6518' : '#deb868',
        blue: light ? '#2b618c' : '#74b0d6',
        magenta: light ? '#7d4d8f' : '#c09bd2',
        cyan: light ? '#1b6a58' : '#52a896',
        white: light ? '#d4d3cb' : '#c7cfca',
        brightBlack: token('--color-muted'),
        brightRed: light ? '#cc3b48' : '#ec8a92',
        brightGreen: light ? '#2c8a5e' : '#85d6aa',
        brightYellow: light ? '#b0761e' : '#eccd86',
        brightBlue: light ? '#3675a8' : '#92c4e3',
        brightMagenta: light ? '#925da6' : '#d2b4e2',
        brightCyan: light ? '#23826d' : '#7cd4bc',
        brightWhite: light ? '#faf9f5' : '#d4d7dc',
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
