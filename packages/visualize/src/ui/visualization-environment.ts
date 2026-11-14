import type { VisualizationEnvironment } from '@pi-meme/contracts/visualize'

const colorKeys = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
]

export function readVisualizationEnvironment(visible = true): VisualizationEnvironment {
  const root = document.documentElement
  const computed = getComputedStyle(root)
  const appearance = root.dataset.appearance === 'light' || computed.colorScheme === 'light' ? 'light' : 'dark'
  const colors = Object.fromEntries(colorKeys.map((key) => [key, computed.getPropertyValue(key).trim()]))
  const primary = colors['--primary'] || computed.color
  const palette =
    appearance === 'light'
      ? ['#2969b0', '#a84919', '#237b55', '#9154b5', '#b03d60']
      : ['#78b3f0', '#efaa73', '#82c6a3', '#bf9aeb', '#ef9bb3']
  colors['--viz-series-1'] = primary
  palette.forEach((color, index) => {
    colors[`--viz-series-${index + 2}`] = color
  })
  const fontSize = Number.parseFloat(computed.getPropertyValue('--text-ui')) || 14
  const radiusValue = computed.getPropertyValue('--radius')
  const radius =
    Number.parseFloat(radiusValue) * (radiusValue.includes('rem') ? Number.parseFloat(computed.fontSize) : 1)
  return {
    appearance,
    reducedMotion:
      root.dataset.reducedMotion === 'true' ||
      (!root.hasAttribute('data-reduced-motion') && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    visible: visible && document.visibilityState !== 'hidden',
    fontFamily: computed.getPropertyValue('--font-content').trim() || computed.fontFamily,
    fontSize,
    radius: Number.isFinite(radius) ? radius : 8,
    colors,
  }
}
