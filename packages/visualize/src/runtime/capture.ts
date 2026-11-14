import { toSvg } from 'html-to-image'
import './types'

const excluded = 'script, iframe, object, embed, [data-viz-capture-exclude]'

function captureFormState(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea'),
  )
    .filter((field) => !field.closest(excluded))
    .map((field) => ({
      tag: field.localName,
      value: field.value,
      checked: field instanceof HTMLInputElement && field.checked,
      selected: field instanceof HTMLSelectElement ? Array.from(field.options, (option) => option.selected) : [],
    }))
}

function applyFormState(svg: string, values: ReturnType<typeof captureFormState>) {
  if (!values.length) return svg
  const snapshot = new DOMParser().parseFromString(decodeURIComponent(svg.slice(svg.indexOf(',') + 1)), 'image/svg+xml')
  const fields = snapshot.querySelectorAll('foreignObject input,foreignObject select,foreignObject textarea')
  if (snapshot.querySelector('parsererror') || fields.length !== values.length)
    throw new Error('捕获期间表单内容已变化，请重试')
  fields.forEach((field, index) => {
    const value = values[index]
    if (field.localName !== value.tag) throw new Error('捕获期间表单内容已变化，请重试')
    if (value.tag === 'select') {
      field.querySelectorAll('option').forEach((option, optionIndex) => {
        option.removeAttribute('selected')
        if (value.selected[optionIndex]) option.setAttribute('selected', '')
      })
    } else if (value.tag === 'textarea') {
      field.textContent = value.value
    } else {
      field.setAttribute('value', value.value)
      field.removeAttribute('checked')
      if (value.checked) field.setAttribute('checked', '')
    }
  })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(snapshot))}`
}

window.__piVisualizeCapture = async () => {
  const root = document.getElementById('visualization-root')
  if (!(root instanceof HTMLElement)) throw new Error('找不到可视化内容')
  await document.fonts.ready
  const bounds = root.getBoundingClientRect()
  const width = Math.max(1, Math.ceil(Math.max(bounds.width, root.scrollWidth)))
  const height = Math.max(1, Math.ceil(Math.max(bounds.height, root.scrollHeight)))
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width > 16384 ||
    height > 16384 ||
    width * height > 64000000
  )
    throw new Error('可视化尺寸超过导出限制')
  const formState = captureFormState(root)
  const serialized = await toSvg(root, {
    width,
    height,
    pixelRatio: 1,
    skipFonts: true,
    cacheBust: false,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    filter: (node) => !(node instanceof Element) || !node.matches(excluded),
  })
  // 1.11.13 不能完整序列化无 value 的 option、optgroup 和 checkbox 当前值。
  const svg = applyFormState(serialized, formState)
  if (
    !/^data:image\/svg\+xml[;,]/.test(svg) ||
    svg.length > 16 * 1048576 ||
    new TextEncoder().encode(svg).length > 16 * 1048576
  )
    throw new Error('可视化 SVG 超过 16 MiB')
  return { svg, width, height }
}
