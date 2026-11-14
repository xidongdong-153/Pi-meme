import type { VisualizationDocument, VisualizationState } from '@pi-meme/contracts/visualize'
import { visualizationPreviewPage } from '../shared/preview-page'
import { loadVisualizationAssets, loadVisualizationStandalone } from './runtime-assets'
import type { StandalonePayload } from '../shared/standalone-types'
import { readVisualizationEnvironment } from './visualization-environment'
import type { VisualizationCapture, VisualizationStateStore } from './visualization-state'

const exporting = new Set<VisualizationStateStore>()

export function visualizationFileName(document: VisualizationDocument, extension: string) {
  const title =
    document.title
      .replace(/[\\/:*?"<>|\p{Cc}]/gu, '-')
      .trim()
      .slice(0, 100) || '可视化'
  return `${title}-v${document.revision}.${extension}`
}

export function downloadVisualizationFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function withVisualizationExport<T>(store: VisualizationStateStore, run: () => Promise<T>) {
  if (exporting.has(store)) throw new Error('此可视化正在导出，请稍后重试')
  exporting.add(store)
  try {
    return await run()
  } finally {
    exporting.delete(store)
  }
}

export function createVisualizationPng(
  capture: () => Promise<VisualizationCapture>,
  background = readVisualizationEnvironment().colors['--background'],
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      image.onload = null
      image.onerror = null
      reject(new Error('生成图像超过 10 秒，请重试'))
    }, 10000)
    void capture()
      .then((snapshot) => {
        if (expired) return
        image.onload = () => {
          try {
            const scale = Math.min(2, 4096 / Math.max(snapshot.width, snapshot.height))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(snapshot.width * scale))
            canvas.height = Math.max(1, Math.round(snapshot.height * scale))
            const context = canvas.getContext('2d')
            if (!context) throw new Error('当前客户端无法生成 PNG')
            context.fillStyle = background
            context.fillRect(0, 0, canvas.width, canvas.height)
            context.drawImage(image, 0, 0, canvas.width, canvas.height)
            canvas.toBlob((blob) => {
              clearTimeout(timer)
              if (blob) resolve(blob)
              else reject(new Error('PNG 编码失败，请重试'))
            }, 'image/png')
          } catch (cause) {
            clearTimeout(timer)
            reject(cause)
          }
        }
        image.onerror = () => {
          clearTimeout(timer)
          reject(new Error('可视化图像无法转换为 PNG'))
        }
        image.src = snapshot.svg
      })
      .catch((cause: unknown) => {
        clearTimeout(timer)
        reject(cause)
      })
  })
}

export async function copyVisualizationImage(capture: () => Promise<VisualizationCapture>) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('当前客户端不能复制图像，可选择“下载 PNG”')
  }
  const png = createVisualizationPng(capture)
  // 在用户点击的调用栈内申请写入；异步捕获完成后再交付图像。
  void png.catch(() => {})
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')) {
      throw new Error('图像复制被拒绝，可选择“下载 PNG”')
    }
    throw cause
  }
}

export async function createStandaloneVisualization(document: VisualizationDocument, state: VisualizationState) {
  const [assets, bootstrap] = await Promise.all([
    loadVisualizationAssets(document.libraries),
    loadVisualizationStandalone(),
  ])
  const payload: StandalonePayload = {
    title: document.title,
    html: document.html,
    shell: visualizationPreviewPage,
    state: { ...state },
    controls: document.controls,
    assets,
    environment: readVisualizationEnvironment(),
    storageKey: `pi-visualization:export:${crypto.randomUUID()}`,
  }
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  const width = document.layout === 'wide' ? 1024 : 736
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src 'self' about: data: blob:; connect-src 'none'; font-src data:; base-uri 'none'; form-action 'none'">
<title>可视化</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;color:var(--foreground);background:var(--background)}main{max-width:${width}px;margin:auto}h1{font-size:1.25rem;font-weight:500;margin:0 0 1rem}iframe{display:block;border:0;width:100%;height:360px}p{color:var(--destructive);overflow-wrap:anywhere}@media(max-width:480px){body{padding:16px}}</style></head>
<body><main><h1></h1><iframe sandbox="allow-scripts" title="交互可视化" referrerpolicy="no-referrer"></iframe><p role="alert" hidden></p></main>
<script id="visualization-data" type="application/json">${json}</script>
<script>${bootstrap}</script></body></html>`
  return new Blob([html], { type: 'text/html;charset=utf-8' })
}
