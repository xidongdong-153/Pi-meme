# 常用图表

需要坐标轴、图例和标准图表交互时声明 `libraries: ['echarts']`，使用 `window.piVisualize.createChart(element, option)`。返回真实 ECharts 实例，默认 SVG、宿主主题和自动 resize；无需 CDN、全局 `echarts` 或私有数据 schema。简单单值进度和少量几何关系也可直接用原生 HTML/SVG。

## 可直接改写的趋势图

保存参数：

```json
{
  "title": "订单趋势",
  "description": "示例数据：上半年订单量。可切换柱状图和折线图，点选月份或通过下拉查看数值。",
  "initialState": { "chartType": "bar", "month": "1月" },
  "controls": [],
  "layout": "regular",
  "libraries": ["echarts"]
}
```

把下方片段作为 `html`。图表没有重复标题、外层卡片或导出工具栏；图内选择只改变状态，不自动提问。下拉为图表点击提供键盘等价入口。

```html
<div id="orders-chart-demo">
  <div class="viz-controls">
    <label class="viz-row" for="orders-chart-demo-type">
      图形
      <select class="form-select" id="orders-chart-demo-type">
        <option value="bar">柱状图</option>
        <option value="line">折线图</option>
      </select>
    </label>
    <label class="viz-row" for="orders-chart-demo-month">
      月份
      <select class="form-select" id="orders-chart-demo-month">
        <option>1月</option>
        <option>2月</option>
        <option>3月</option>
        <option>4月</option>
        <option>5月</option>
        <option>6月</option>
      </select>
    </label>
    <output class="text-small tabular-nums" data-selection aria-live="polite"></output>
  </div>
  <div class="orders-plot" role="img" aria-label="上半年订单量，示例数据"></div>
  <p class="text-small" data-error role="alert" hidden></p>
</div>
<style>
  #orders-chart-demo {
    display: grid;
    gap: var(--font-size-base);
    min-width: 0;
  }
  #orders-chart-demo .orders-plot {
    min-width: 0;
    width: 100%;
    height: calc(var(--font-size-base) * 22);
  }
</style>
<script>
  ;(() => {
    const root = document.getElementById('orders-chart-demo')
    const api = window.piVisualize
    const plot = root.querySelector('.orders-plot')
    const typeSelect = root.querySelector('#orders-chart-demo-type')
    const monthSelect = root.querySelector('#orders-chart-demo-month')
    const selection = root.querySelector('[data-selection]')
    const errorText = root.querySelector('[data-error]')
    const rows = [
      ['1月', 120],
      ['2月', 98],
      ['3月', 156],
      ['4月', 180],
      ['5月', 172],
      ['6月', 210],
    ]
    let state = api.getState()
    let environment = api.getEnvironment()

    function optionFor() {
      return {
        animation: !environment.reducedMotion && environment.visible,
        aria: { enabled: true },
        grid: { top: 36, right: 12, bottom: 12, left: 12, containLabel: true },
        tooltip: { trigger: 'axis', renderMode: 'richText' },
        dataset: { dimensions: ['月份', '订单量'], source: rows },
        xAxis: { type: 'category', axisLabel: { hideOverlap: true } },
        yAxis: { type: 'value', name: '订单量', min: 0 },
        series: [
          {
            id: 'orders',
            name: '订单量',
            type: state.chartType,
            encode: { x: '月份', y: '订单量' },
            barMaxWidth: 40,
            symbolSize: 7,
          },
        ],
      }
    }

    const chart = api.createChart(plot, optionFor())
    function render() {
      typeSelect.value = state.chartType
      monthSelect.value = state.month
      const row = rows.find(([month]) => month === state.month)
      selection.textContent = row ? `${row[0]} · ${row[1]} 单` : ''
      chart.setOption(optionFor(), { notMerge: true })
    }
    async function update(patch) {
      errorText.hidden = true
      try {
        await api.setState(patch)
      } catch (error) {
        errorText.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}`
        errorText.hidden = false
        render()
      }
    }
    typeSelect.addEventListener('change', () => update({ chartType: typeSelect.value }))
    monthSelect.addEventListener('change', () => update({ month: monthSelect.value }))
    chart.on('click', (event) => {
      if (event.componentType === 'series' && rows[event.dataIndex]) {
        update({ month: rows[event.dataIndex][0] })
      }
    })
    const stopState = api.subscribe((next) => {
      state = next
      render()
    })
    const stopEnvironment = api.subscribeEnvironment((next) => {
      environment = next
      render()
    })
    render()
    window.addEventListener(
      'pagehide',
      () => {
        stopState()
        stopEnvironment()
        chart.dispose()
      },
      { once: true },
    )
  })()
</script>
```

数据源、单位和解释随实际任务替换。传入 `createChart` / `setOption` 的仍是标准 ECharts option；`initialState` 只保存图形类型、选中项等标量。需保留筛选、缩放或图例选择时，预先声明相应标量，并在实例事件中提交、在状态订阅中还原；不要把整个事件对象或 option 保存为状态。

## 按问题选择 option

以下都是可传给 `createChart(element, option)` 的标准 option 片段，按需添加布局、无障碍与交互。它们是创作示例，不代表实际统计数据，也不需要同时放到一个可视化中。

### 分类比较：横向条形

标签较长时优先横向条形，数量轴从 0 开始。只比较一个指标时用单系列色。

```js
const option = {
  grid: { left: 12, right: 12, top: 12, bottom: 12, containLabel: true },
  tooltip: { trigger: 'axis', renderMode: 'richText' },
  xAxis: { type: 'value', min: 0 },
  yAxis: { type: 'category', data: ['设计', '开发', '复核'] },
  series: [{ name: '工时', type: 'bar', data: [8, 14, 5], barMaxWidth: 30 }],
}
```

### 时间变化：折线

保留实际时间间隔。缺测用 `null`，不要用 0 冒充；仅在业务允许时连接缺测点。

```js
const option = {
  tooltip: { trigger: 'axis', renderMode: 'richText' },
  xAxis: { type: 'category', data: ['周一', '周二', '周三', '周四'] },
  yAxis: { type: 'value', name: '请求数', min: 0 },
  series: [{ name: '请求数', type: 'line', data: [80, 120, null, 150], connectNulls: false }],
}
```

### 构成变化：堆叠柱状

多期组成用堆叠图；固定类别的系列颜色保持一致。百分比组成应先按期归一化，并明确百分比单位。

```js
const option = {
  legend: { top: 0 },
  grid: { top: 44, left: 12, right: 12, bottom: 12, containLabel: true },
  tooltip: { trigger: 'axis', renderMode: 'richText' },
  xAxis: { type: 'category', data: ['一季度', '二季度', '三季度'] },
  yAxis: { type: 'value', name: '工时', min: 0 },
  series: [
    { name: '研发', type: 'bar', stack: 'work', data: [40, 48, 52] },
    { name: '维护', type: 'bar', stack: 'work', data: [20, 18, 16] },
  ],
}
```

### 相关性：散点

两个坐标轴写清变量与单位，不把相关性表述为因果关系。

```js
const option = {
  tooltip: { trigger: 'item', renderMode: 'richText' },
  xAxis: { type: 'value', name: '时长 / 分钟', nameLocation: 'middle', nameGap: 28 },
  yAxis: { type: 'value', name: '完成量 / 件' },
  series: [
    {
      name: '样本',
      type: 'scatter',
      symbolSize: 10,
      data: [
        [5, 3],
        [8, 6],
        [12, 8],
        [20, 11],
      ],
    },
  ],
}
```

### 单期组成：环形

只在少量类别、单个整体关系明确时使用。类别多或差值接近时改用条形；窄宽度可把标签放进图例，避免挤出画布。

```js
const option = {
  tooltip: { trigger: 'item', renderMode: 'richText' },
  legend: { bottom: 0 },
  series: [
    {
      name: '投入',
      type: 'pie',
      radius: ['40%', '65%'],
      center: ['50%', '42%'],
      label: { show: false },
      data: [
        { name: '研发', value: 52 },
        { name: '维护', value: 16 },
        { name: '支持', value: 12 },
      ],
    },
  ],
}
```

不要在 option 中重复宿主 `title`，也不打开 `toolbox.saveAsImage` 来创建第二套导出。图例、tooltip 与数据标签各有用途，不同时重复全部数值。默认主题处理坐标轴、文字和系列配色；确需自定义颜色时，从当前环境或计算样式取得实际主题颜色，并在环境变化时更新。
