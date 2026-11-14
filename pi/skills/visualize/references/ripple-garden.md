# 波纹花园

适合解释“同一公式如何随参数变化”。保留涟漪、花瓣、漩涡三种形态与起伏滑块；36 层曲线和 12 个种子点均用原生 SVG，不声明图表库。这里只提供可改写的 Markdown 示例。

保存参数：

```json
{
  "title": "波纹花园",
  "description": "切换形态并调整起伏，观察同心曲线的形变；这是参数化图形，不是物理流体模拟。",
  "initialState": { "shape": "petal", "amplitude": 60 },
  "controls": [],
  "layout": "regular"
}
```

把下方片段作为 `html`；标题、放大和导出由宿主提供。需要宿主设计参数时可按协议为同名状态键添加控件，不另建状态副本。

```html
<div id="ripple-garden-demo">
  <div class="rg-drawing">
    <svg class="rg-art" role="img" aria-label="随形态和起伏变化的三十六层同心曲线">
      <defs>
        <radialGradient id="ripple-garden-demo-wash">
          <stop offset="0%" stop-color="var(--viz-series-1)" stop-opacity="0.13"></stop>
          <stop offset="100%" stop-color="var(--viz-series-1)" stop-opacity="0"></stop>
        </radialGradient>
      </defs>
      <ellipse class="rg-wash" fill="url(#ripple-garden-demo-wash)"></ellipse>
      <g class="rg-contours" fill="none" stroke="currentColor" stroke-width="1.2"></g>
      <g class="rg-seeds" fill="currentColor"></g>
    </svg>
  </div>
  <div class="viz-controls">
    <div class="viz-row" role="group" aria-label="图案形态">
      <button class="btn" type="button" data-shape="ripple" aria-pressed="false">涟漪</button>
      <button class="btn" type="button" data-shape="petal" aria-pressed="true">花瓣</button>
      <button class="btn" type="button" data-shape="vortex" aria-pressed="false">漩涡</button>
    </div>
    <label class="rg-amplitude" for="ripple-garden-demo-amplitude">
      <span class="viz-row">起伏 <output class="tabular-nums" for="ripple-garden-demo-amplitude">60%</output></span>
      <input id="ripple-garden-demo-amplitude" class="form-range" type="range" min="0" max="100" step="1" value="60" />
    </label>
  </div>
  <span class="sr-only" data-status aria-live="polite"></span>
  <p class="text-small" data-error role="alert" hidden></p>
</div>
<style>
  #ripple-garden-demo {
    display: grid;
    gap: var(--font-size-base);
    min-width: 0;
    color: var(--foreground);
  }
  #ripple-garden-demo .rg-drawing {
    height: clamp(240px, 52vw, 380px);
    min-width: 0;
  }
  #ripple-garden-demo .rg-art {
    display: block;
    width: 100%;
    height: 100%;
    color: var(--viz-series-1);
  }
  #ripple-garden-demo .rg-amplitude {
    display: grid;
    gap: calc(var(--font-size-base) * 0.25);
    flex: 1 1 10rem;
    min-width: 0;
  }
</style>
<script>
  ;(() => {
    const root = document.getElementById('ripple-garden-demo')
    const api = window.piVisualize
    const svg = root.querySelector('.rg-art')
    const contours = root.querySelector('.rg-contours')
    const seeds = root.querySelector('.rg-seeds')
    const wash = root.querySelector('.rg-wash')
    const slider = root.querySelector('input')
    const output = root.querySelector('output')
    const status = root.querySelector('[data-status]')
    const errorText = root.querySelector('[data-error]')
    const buttons = Array.from(root.querySelectorAll('[data-shape]'))
    const names = { ripple: '涟漪', petal: '花瓣', vortex: '漩涡' }
    const profiles = { ripple: [1, 0, 0], petal: [0, 1, 0], vortex: [0, 0, 1] }
    const ns = 'http://www.w3.org/2000/svg'
    const paths = Array.from({ length: 36 }, (_, index) => {
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('opacity', String(0.28 + 0.65 * (index / 35)))
      contours.appendChild(path)
      return path
    })
    const dots = Array.from({ length: 12 }, () => {
      const dot = document.createElementNS(ns, 'circle')
      dot.setAttribute('r', '2.4')
      seeds.appendChild(dot)
      return dot
    })
    let state = api.getState()
    let environment = api.getEnvironment()
    let displayed = [...profiles[state.shape], state.amplitude]
    let width = 0
    let height = 0
    let frame = 0

    function point(layer, angle, profile) {
      const [rippleWeight, petalWeight, vortexWeight, amplitude] = profile
      const amount = amplitude / 100
      const radius = Math.min(width, height) * 0.365 * layer
      const deformation =
        rippleWeight * 0.16 * Math.cos(2 * (angle - layer * 0.08 - 0.32)) +
        petalWeight * Math.cos(6 * (angle - layer * 0.05 - 0.32)) +
        vortexWeight * 0.7 * Math.cos(3 * (angle - layer * 1.5 - 0.32))
      const wave = 1 + amount * 0.21 * deformation
      const ripple = amount * 0.02 * Math.sin(3 * angle + layer * 8)
      const distance = radius * (wave + ripple)
      return [width / 2 + distance * Math.cos(angle), height / 2 + distance * Math.sin(angle)]
    }

    function draw(profile) {
      if (!width || !height || !environment.visible) return
      paths.forEach((path, index) => {
        const layer = 0.11 + (index / 35) * 0.89
        const points = Array.from({ length: 301 }, (_, sample) => {
          const [x, y] = point(layer, (sample / 300) * Math.PI * 2, profile)
          return `${sample === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
        })
        path.setAttribute('d', `${points.join(' ')} Z`)
      })
      dots.forEach((dot, index) => {
        const [x, y] = point(0.45 + (index % 3) * 0.25, (index / 12) * Math.PI * 2, profile)
        dot.setAttribute('cx', x.toFixed(2))
        dot.setAttribute('cy', y.toFixed(2))
        dot.setAttribute('opacity', String(0.4 + (index % 3) * 0.25))
      })
    }

    function render(animate) {
      cancelAnimationFrame(frame)
      slider.value = String(state.amplitude)
      output.value = `${state.amplitude}%`
      buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.shape === state.shape)))
      const target = [...profiles[state.shape], state.amplitude]
      if (!animate || environment.reducedMotion || !environment.visible) {
        displayed = target
        draw(displayed)
        return
      }
      const from = [...displayed]
      const start = performance.now()
      function step(now) {
        const progress = Math.min(1, (now - start) / 320)
        const eased = 1 - Math.pow(1 - progress, 3)
        displayed = target.map((value, index) => from[index] + (value - from[index]) * eased)
        draw(displayed)
        if (progress < 1) frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
    }

    async function update(patch) {
      errorText.hidden = true
      try {
        await api.setState(patch)
      } catch (error) {
        errorText.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}`
        errorText.hidden = false
        render(false)
      }
    }

    buttons.forEach((button) => button.addEventListener('click', () => update({ shape: button.dataset.shape })))
    slider.addEventListener('input', () => update({ amplitude: Number(slider.value) }))
    slider.addEventListener('change', () => {
      status.textContent = `${names[state.shape]}，起伏 ${slider.value}%`
    })
    const stopState = api.subscribe((next) => {
      const shapeChanged = next.shape !== state.shape
      state = next
      render(shapeChanged)
      if (shapeChanged) status.textContent = `${names[state.shape]}，起伏 ${state.amplitude}%`
    })
    const stopEnvironment = api.subscribeEnvironment((next) => {
      environment = next
      render(false)
    })
    const observer = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width
      height = entries[0].contentRect.height
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
      wash.setAttribute('cx', String(width / 2))
      wash.setAttribute('cy', String(height / 2))
      wash.setAttribute('rx', String(Math.min(width, height) * 0.49))
      wash.setAttribute('ry', String(Math.min(width, height) * 0.49))
      draw(displayed)
    })
    observer.observe(root.querySelector('.rg-drawing'))
    render(false)
    window.addEventListener(
      'pagehide',
      () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
        stopState()
        stopEnvironment()
      },
      { once: true },
    )
  })()
</script>
```

公式中层数 `layer` 从 0.11 到 1，基准半径为 `min(width, height) × 0.365 × layer`。形变分别组合二倍、六倍、三倍角余弦，再叠加一个三倍角正弦微扰；`amplitude / 100` 控制形变幅度。切换形态时用 320ms 三次缓出插值，起伏拖动直接重绘。环境要求减少动效或不可见时停止过渡，恢复可见后呈现最终状态，不补播后台动画。

改变层数时同时调整不透明度和层间距的分母；调整最大幅度时保留画布边缘余量。这里的公式说明是创作参考，不必复制进可视化正文。
