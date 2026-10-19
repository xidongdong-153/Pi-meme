let pending: Promise<typeof import('mermaid').default> | undefined
let queue = Promise.resolve()
let diagramId = 0

export function readMermaidTheme() {
  const root = document.documentElement
  const style = window.getComputedStyle(root)
  const colors = Object.fromEntries(
    Object.entries({
      background: 'background',
      primaryColor: 'surface',
      primaryTextColor: 'text',
      primaryBorderColor: 'accent',
      secondaryColor: 'elevated',
      secondaryTextColor: 'text',
      tertiaryColor: 'surface',
      tertiaryTextColor: 'text',
      lineColor: 'muted',
      textColor: 'text',
      edgeLabelBackground: 'background',
    })
      .map(([key, token]) => [key, style.getPropertyValue(`--color-${token}`).trim()] as const)
      .filter(([, value]) => value),
  )
  return {
    ...colors,
    darkMode: root.dataset.appearance !== 'light',
    fontFamily: style.getPropertyValue('--font-code').trim() || 'monospace',
  }
}

export type MermaidTheme = ReturnType<typeof readMermaidTheme>

export function normalizeMermaidSvg(svg: string) {
  // Mermaid 返回的是 HTML 中的 SVG；先在惰性模板中解析，补全 xlink 等 XML 命名空间。
  const template = document.createElement('template')
  template.innerHTML = svg
  const root = template.content.querySelector('svg')
  const viewBox = root
    ?.getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  if (
    !root ||
    !viewBox ||
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  ) {
    throw new Error('图表没有有效的 SVG 尺寸。')
  }
  if (root.querySelector('foreignObject, image')) {
    throw new Error('图表包含不支持的 HTML 或图片内容。')
  }
  root.setAttribute('width', String(viewBox[2]))
  root.setAttribute('height', String(viewBox[3]))
  root.style.removeProperty('max-width')
  for (const link of root.querySelectorAll('a')) link.replaceWith(...link.childNodes)
  for (const element of root.querySelectorAll('script, iframe, object, embed')) element.remove()
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        (['href', 'xlink:href'].includes(attribute.name) && !attribute.value.startsWith('#'))
      ) {
        element.removeAttributeNode(attribute)
      }
    }
  }
  return new XMLSerializer().serializeToString(root)
}

export function renderMermaid(code: string, theme: MermaidTheme): Promise<string> {
  if (!code.trim()) return Promise.reject(new Error('图表源码为空。'))
  if (code.length > 50000) return Promise.reject(new Error('图表源码超过 50000 个字符。'))

  // initialize 不在 Mermaid 自身的渲染队列内，配置与渲染必须作为同一个任务执行。
  const result = queue.then(async () => {
    pending ??= import('mermaid')
      .then((module) => module.default)
      .catch((cause: unknown) => {
        pending = undefined
        throw cause
      })
    const mermaid = await pending
    await document.fonts?.ready
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50000,
      maxEdges: 500,
      theme: 'base',
      themeVariables: theme,
      fontFamily: theme.fontFamily,
      look: 'classic',
      layout: 'dagre',
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'htmlLabels',
        'dompurifyConfig',
        'theme',
        'themeVariables',
        'themeCSS',
        'fontFamily',
        'look',
        'layout',
      ],
    })
    const { svg } = await mermaid.render(`pi-mermaid-${++diagramId}`, code)
    return normalizeMermaidSvg(svg)
  })
  queue = result.then(
    () => {},
    () => {},
  )
  return result
}
