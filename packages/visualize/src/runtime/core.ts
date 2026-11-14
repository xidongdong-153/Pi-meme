import * as lucide from 'lucide'
import styles from './styles.css?inline'
import { installTabs } from './tabs'
import { installTooltips } from './tooltip'
import './types'

const container = document.getElementById('visualization-root')
if (!(container instanceof HTMLElement) || !window.piVisualize) throw new Error('可视化预览壳尚未初始化')
const root: HTMLElement = container

const style = document.createElement('style')
style.dataset.piVisualizeRuntime = '2'
style.textContent = styles
// 基础样式始终先于片段样式，片段可以覆盖默认外观。
document.head.append(style)
window.lucide = lucide

const tabs = installTabs(root)
const tooltip = installTooltips(root)
function icons() {
  for (const node of root.querySelectorAll<HTMLElement>('[data-lucide], [data-icon]')) {
    if (node.namespaceURI === 'http://www.w3.org/2000/svg') continue
    const raw = node.dataset.lucide ?? node.dataset.icon ?? ''
    const name = raw.replace(/(^|[-_\s])([a-z])/g, (_match, _separator: string, letter: string) => letter.toUpperCase())
    if (!Object.hasOwn(lucide.icons, name)) continue
    const icon = lucide.icons[name as keyof typeof lucide.icons]
    const attributes = Object.fromEntries(Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]))
    const svg = lucide.createElement(icon, {
      'aria-hidden': node.hasAttribute('aria-label') ? 'false' : 'true',
      focusable: 'false',
      ...attributes,
      class: `lucide lucide-${raw} ${node.getAttribute('class') ?? ''}`.trim(),
    })
    node.replaceWith(svg)
  }
}
function refresh() {
  tabs.refresh()
  icons()
  tooltip.refresh()
}
window.piVisualize.refresh = refresh
let frame = 0
const observer = new MutationObserver(() => {
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0
      refresh()
    })
})
observer.observe(root, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    'data-lucide',
    'data-icon',
    'data-tooltip',
    'aria-controls',
    'data-tab',
    'data-tab-target',
    'disabled',
    'aria-disabled',
  ],
})
const unsubscribe = window.piVisualize.subscribeEnvironment((environment) => {
  if (!environment.visible) tooltip.hide()
})
refresh()
window.addEventListener(
  'pagehide',
  () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    tabs.dispose()
    tooltip.dispose()
    unsubscribe()
  },
  { once: true },
)
