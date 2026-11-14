import * as echarts from 'echarts'
import type { ECharts, EChartsOption, SetOptionOpts } from 'echarts'
import type { VisualizationEnvironment } from '@pi-meme/contracts/visualize'
import './types'

const api = window.piVisualize
const root = document.getElementById('visualization-root')
if (!api || !(root instanceof HTMLElement)) throw new Error('可视化预览壳尚未初始化')
window.echarts = echarts
let environment = api.getEnvironment()
const media = matchMedia('(prefers-reduced-motion: reduce)')
const motionOff = () => environment.reducedMotion || media.matches || !environment.visible || document.hidden

type ManagedChart = {
  chart: ECharts
  element: HTMLElement
  setOption: ECharts['setOption']
  userAnimation: boolean
  width: number
  height: number
}
const charts = new Map<HTMLElement, ManagedChart>()

function theme(current: VisualizationEnvironment) {
  const style = getComputedStyle(document.documentElement)
  const color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback
  const foreground = color('--foreground', current.appearance === 'dark' ? '#e8e8ed' : '#22232a')
  const muted = color('--muted-foreground', current.appearance === 'dark' ? '#aaaab5' : '#676974')
  const border = color('--border', current.appearance === 'dark' ? '#363640' : '#e4e4ea')
  const surface = color('--card', current.appearance === 'dark' ? '#202027' : '#ffffff')
  const colors = ['#5376e8', '#16a394', '#d49930', '#a16ada', '#df728e', '#418eb7', '#82a246', '#cd724a'].map(
    (fallback, index) => color(`--viz-series-${index + 1}`, fallback),
  )
  const textStyle = { fontFamily: current.fontFamily, fontSize: current.fontSize, color: foreground }
  const axis = {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: muted, fontFamily: current.fontFamily, fontSize: Math.max(11, current.fontSize - 2) },
    nameTextStyle: { color: muted, fontFamily: current.fontFamily },
    splitLine: { lineStyle: { color: border, type: 'solid', width: 1 } },
    splitArea: { show: false },
  }
  return {
    color: colors,
    backgroundColor: 'transparent',
    darkMode: current.appearance === 'dark',
    textStyle,
    animationDuration: 240,
    animationDurationUpdate: 180,
    title: { textStyle: { ...textStyle, fontWeight: 500 }, subtextStyle: { color: muted } },
    legend: { textStyle: { ...textStyle, color: muted }, pageTextStyle: textStyle },
    tooltip: { renderMode: 'richText', confine: true, backgroundColor: surface, borderColor: border, textStyle },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
    radar: {
      axisName: { color: muted },
      axisLine: { lineStyle: { color: border } },
      splitLine: { lineStyle: { color: border } },
    },
    visualMap: { textStyle: { color: muted } },
    timeline: { label: { color: muted }, lineStyle: { color: border } },
    aria: { enabled: true },
  }
}

let resizeFrame = 0
function resizeCharts() {
  resizeFrame = 0
  if (!environment.visible || document.hidden) return
  for (const entry of charts.values()) {
    if (entry.chart.isDisposed()) continue
    const width = entry.element.clientWidth
    const height = entry.element.clientHeight
    if (width <= 0 || height <= 0 || (entry.width === width && entry.height === height)) continue
    entry.width = width
    entry.height = height
    entry.chart.resize({ width, height, animation: { duration: 0 } })
  }
}
function scheduleResize() {
  if (!resizeFrame && environment.visible) resizeFrame = requestAnimationFrame(resizeCharts)
}
const resizeObserver = new ResizeObserver(scheduleResize)

api.createChart = (element, option) => {
  if (!(element instanceof HTMLElement) || !root.contains(element)) throw new Error('图表容器必须位于当前可视化中')
  if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('图表配置必须是对象')
  const managed = charts.get(element)
  if (managed && !managed.chart.isDisposed()) {
    managed.chart.setOption(option)
    return managed.chart
  }
  element.classList.add('viz-chart')
  const chart =
    echarts.getInstanceByDom(element) ??
    echarts.init(element, theme(environment), {
      renderer: 'svg',
      width: element.clientWidth || 1,
      height: element.clientHeight || 1,
    })
  const setOption = chart.setOption.bind(chart) as ECharts['setOption']
  const entry: ManagedChart = {
    chart,
    element,
    setOption,
    userAnimation: option.animation !== false,
    width: element.clientWidth,
    height: element.clientHeight,
  }
  charts.set(element, entry)
  chart.setOption = ((next: EChartsOption, options?: boolean | SetOptionOpts, lazyUpdate?: boolean) => {
    if (typeof next.animation === 'boolean') entry.userAnimation = next.animation
    const adjusted = { ...next, animation: !motionOff() && entry.userAnimation }
    if (typeof options === 'object') setOption(adjusted, options)
    else setOption(adjusted, options, lazyUpdate)
  }) as ECharts['setOption']
  const dispose = chart.dispose.bind(chart)
  chart.dispose = () => {
    charts.delete(element)
    resizeObserver.unobserve(element)
    dispose()
  }
  resizeObserver.observe(element)
  try {
    chart.setOption(option)
    if (!environment.visible) chart.getZr().animation.stop()
    scheduleResize()
    return chart
  } catch (cause) {
    chart.dispose()
    throw cause
  }
}

let currentTheme = JSON.stringify(theme(environment))
function updateEnvironment() {
  const nextTheme = theme(environment)
  const signature = JSON.stringify(nextTheme)
  for (const entry of charts.values()) {
    if (entry.chart.isDisposed()) continue
    if (currentTheme !== signature) entry.chart.setTheme(nextTheme)
    entry.setOption({ animation: !motionOff() && entry.userAnimation })
    if (!environment.visible || document.hidden) {
      entry.chart.dispatchAction({ type: 'hideTip' })
      entry.chart.getZr().animation.stop()
    } else {
      entry.chart.getZr().animation.start()
      if (motionOff()) {
        // 切换减少动态效果时停止已经开始的图元动画，直接保留最终状态。
        const elements = entry.chart.getZr().storage.getDisplayList()
        elements.forEach((element) => element.stopAnimation(undefined, true))
        entry.chart.getZr().flush()
      }
    }
  }
  currentTheme = signature
  scheduleResize()
}
const unsubscribe = api.subscribeEnvironment((next) => {
  environment = next
  updateEnvironment()
})
media.addEventListener('change', updateEnvironment)
document.addEventListener('visibilitychange', updateEnvironment)
const removals = new MutationObserver(() => {
  for (const entry of charts.values()) {
    if (!root.contains(entry.element)) entry.chart.dispose()
  }
})
removals.observe(root, { subtree: true, childList: true })
window.addEventListener('resize', scheduleResize)
window.addEventListener(
  'pagehide',
  () => {
    cancelAnimationFrame(resizeFrame)
    unsubscribe()
    resizeObserver.disconnect()
    removals.disconnect()
    media.removeEventListener('change', updateEnvironment)
    document.removeEventListener('visibilitychange', updateEnvironment)
    window.removeEventListener('resize', scheduleResize)
    for (const entry of charts.values()) entry.chart.dispose()
  },
  { once: true },
)
