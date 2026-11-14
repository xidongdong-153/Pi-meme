# 工具、运行时与状态协议

这里描述 pi-meme 的可视化协议。参考其他环境的示例时，以本协议和当前工具 schema 为准。

## 保存和读取

`save_visualization` 接收完整版本：

| 字段           | 必填 | 约束                                                                        |
| -------------- | ---- | --------------------------------------------------------------------------- |
| `title`        | 是   | 非空字符串，最多 120 字符；由宿主唯一显示，片段不重复标题                   |
| `description`  | 是   | 非空字符串，最多 4000 字符；关键交互、数据来源或模拟边界                    |
| `html`         | 是   | 非空 HTML 片段，UTF-8 最大 1 MiB；内联 CSS、JS，不含文档外壳                |
| `initialState` | 是   | 一层 JSON 对象，值仅为 string、有限 number、boolean；UTF-8 JSON 最大 16 KiB |
| `controls`     | 是   | 最多 12 项；无需宿主设计参数时传 `[]`                                       |
| `reference`    | 否   | 修改已有可视化时必填 `{ id, revision }`；新建时省略                         |
| `layout`       | 否   | `'regular'` 或 `'wide'`；省略为常规布局                                     |
| `libraries`    | 否   | 省略或 `[]` 使用原生能力；`['echarts']` 声明宿主提供的 ECharts              |

常规内联上限 736px，宽布局上限 1024px；实际宽度受聊天区域限制，两者都须适配 320px。宽布局用于确需并列比较或较密集坐标轴的内容，不用于扩大单张卡片。放大由宿主提供，不改变片段协议和状态。

状态可以为空对象。键必须匹配 `^[a-zA-Z][\w-]{0,63}$`，不能是 `constructor`、`prototype` 或 `__proto__`；建议 camelCase。数组、嵌套对象、`null`、`NaN`、`Infinity` 均不能作为状态值。数据集、图表 option 和可推导值保留在片段内，不修改此限制。

每个控件包含非空 `label`、唯一 `key` 和 `type`；`key` 必须存在于 `initialState`。最多 12 项按整份可视化计算，只传对应类型需要的字段。

```json
{
  "initialState": {
    "stage": "ready",
    "compact": false,
    "progress": 40,
    "accent": "#22aa88"
  },
  "controls": [
    {
      "type": "select",
      "key": "stage",
      "label": "演示状态",
      "options": [
        { "label": "待处理", "value": "ready" },
        { "label": "已完成", "value": "done" }
      ]
    },
    { "type": "toggle", "key": "compact", "label": "紧凑模式" },
    { "type": "slider", "key": "progress", "label": "进度", "min": 0, "max": 100, "step": 5, "unit": "%" },
    { "type": "color", "key": "accent", "label": "强调色" }
  ]
}
```

- `select`：1–12 项，`label/value` 为字符串，value 不重复；初值与运行时值必须对应选项。
- `toggle`：值必须为 boolean，不用字符串 `"true"` 或数值代替。
- `slider`：有限数值，`min < max`，`step` 默认 1 且大于 0；值在范围内并符合从 min 起的步长。`unit` 只用于显示。
- `color`：六位十六进制 `#RRGGBB`，不使用短色值、命名色或透明度。

保存返回固定版本代码块和结构化 `details.visualization` 引用。不要生成 ID 或递增版本。`read_visualization({ reference: { id, revision } })` 返回可访问的完整版本，包括 HTML、状态、控件和元数据；读取的是保存版本，不是当前浏览器状态。

更新时只提交业务字段和 `reference`，不传读取结果中的 `schemaVersion/createdAt/callId` 或顶层 `id/revision`。版本不可变；同一工具调用重试幂等，当前分支已有更新时拒绝过期基础版本。访问依据当前执行会话的真实分支引用，普通消息里写出 ID 不构成授权。

## 片段状态 API

| 方法                             | 返回                      | 用法                                   |
| -------------------------------- | ------------------------- | -------------------------------------- |
| `getState()`                     | 当前完整状态的副本        | 首次渲染、读取当前值                   |
| `setState(patch)`                | Promise，成功返回完整状态 | 提交一个或多个声明键的变化             |
| `subscribe(listener)`            | 取消订阅函数              | 接收完整状态，更新 DOM 和样式          |
| `getEnvironment()`               | 当前环境快照              | 读取主题、动效与可见性                 |
| `subscribeEnvironment(listener)` | 取消订阅函数              | 接收新的完整环境，重绘或暂停动画       |
| `createChart(element, option)`   | ECharts 实例              | 仅声明 `echarts` 后可用，传标准 option |

宿主在运行片段脚本前完成初始化。不要创建 fallback 状态桥接来掩盖初始化失败。第一次渲染主动读取状态和环境，订阅不代替初始化。

`setState` 提交补丁而非替换：省略键保留，不能增加、删除键或改变类型；合并后验证完整状态和控件约束。不要假设提交后立即 `getState()` 已更新，使用订阅回调或 `await setState(...)` 的结果。捕获拒绝并显示错误，保留可继续操作的界面。

同一帧的连续补丁会合并发送，同键后写覆盖前值；这些调用的 Promise 返回同一批次确认后的完整状态。一次操作影响多个键时仍直接提交一个补丁，不依靠调用顺序逐步构造中间画面。

```js
const api = window.piVisualize
let state = api.getState()
let environment = api.getEnvironment()

render(state, environment)
const stopState = api.subscribe((next) => {
  state = next
  render(state, environment)
})
const stopEnvironment = api.subscribeEnvironment((next) => {
  environment = next
  render(state, environment)
})
```

`render` 只读状态、更新画面，不回写状态或保存版本。组件移除而页面仍存活时取消订阅，清理观察器、计时器、动画帧与图表实例；整个 iframe 销毁时其运行上下文一并释放。

## 环境与统一样式

环境字段：

| 字段            | 语义                                                              |
| --------------- | ----------------------------------------------------------------- |
| `appearance`    | 宿主当前实际明暗外观                                              |
| `reducedMotion` | 生效的减少动态效果偏好                                            |
| `visible`       | 当前预览是否可见；为假时停止动画和无用绘制                        |
| `fontFamily`    | 内容字体                                                          |
| `fontSize`      | 内容基础字号，数值，单位 px                                       |
| `radius`        | 宿主圆角参数，数值，单位 px                                       |
| `colors`        | 当前主题颜色映射，键如 `--foreground`，供 Canvas 等命令式绘图使用 |

环境来自宿主，不写入业务状态，不用 `setState` 修改环境。CSS/SVG 优先使用主题变量；Canvas 可用 `getComputedStyle(root).getPropertyValue('--foreground').trim()` 读取实际颜色，不能把未经解析的 `var(...)` 直接赋给 Canvas。以环境回调触发重绘；不要只在初始化时固定亮色或深色。

基础变量包括 `--font-size-base`、`--background/--foreground`、`--card/--card-foreground`、`--muted/--muted-foreground`、`--primary/--primary-foreground`、`--accent/--accent-foreground`、`--border` 与 `--viz-series-1` 到 `--viz-series-6`。颜色是完整 CSS 值，直接使用。

| 元素             | 用法                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| 按钮             | `class="btn"`，主操作加 `btn-primary`，低强调加 `btn-ghost`                      |
| 输入、下拉、滑块 | 原生元素分别用 `form-control`、`form-select`、`form-range`                       |
| 勾选、开关       | `form-check` 排列标签与原生勾选控件；checkbox 开关用 `form-switch`               |
| 必要卡片         | `card`；不覆盖其外观，不嵌套                                                     |
| 排列与指标       | `viz-grid`、`viz-row`、`viz-controls`、`viz-stat`、`viz-stat-value`、`viz-badge` |
| 表格             | 原生 `table` 加 `table`，保留表头和单元格语义                                    |
| 文字             | `text-small`、`text-muted`、`tabular-nums`、`sr-only`                            |
| Tab              | `nav` / `nav-pills`、`nav-link`，结合 ARIA Tab 关系                              |
| 提示、图标       | `data-tooltip="提示"`，`data-lucide="图标名"`                                    |

运行时初始化 Tab 点击及方向键、Home/End 键盘交互，管理焦点、选中状态和面板可见性。Tab 使用原生 `button role="tab"`，以唯一 ID、`aria-controls` 对应 `role="tabpanel"`；面板通过 `aria-labelledby` 反向关联。切换后从选中 Tab 发出冒泡 `tabchange`，`event.detail.value` 为 `data-tab` 值（未提供时使用面板 ID）。片段监听它提交状态，不只监听 click，以便键盘操作同样持久化；不重复实现键盘导航。状态订阅更新 `aria-selected`、`.active`、`tabIndex` 和 `hidden`，不强制抢焦点。完整例见 [UI Tab 预览](ui-tabs.md)。

Tooltip 不能承载必读信息，图标不代替名称。无障碍名称与表单标签仍由片段提供。顶层透明无框，宿主提供唯一标题与操作；不要重写工具类、其子元素或伪元素的尺寸、配色、边框、焦点状态。

## ECharts

保存时声明 `libraries: ['echarts']` 后，宿主离线提供图表库；不要再加 `<script src>`、CDN 或依赖全局 `echarts`。`api.createChart(element, option)` 默认使用 SVG、宿主主题与自动 resize，返回真实 ECharts 实例，可以使用 `setOption/on/off/resize/dispose` 等实例方法。

数据直接传标准 option 的 `dataset/series/xAxis/yAxis` 等字段；不使用额外的包装 schema。图表容器需有可测量高度；不要每次状态变化都重建实例。业务用 `setOption` 更新数据，修改图形类型时处理旧系列合并，隐藏面板再次显示后必要时 `resize()`。主题与尺寸默认由运行时适配，额外业务配色仍需使用主题系列色。见 [常用图表](charts.md)。

## 状态、版本、反馈与导出

- 点击和设计参数只改变预览状态，不保存版本、不自动给模型发消息。只有用户提交宿主反馈才进入当前会话，附带确切引用和当时状态。
- 同一 Host、会话、可视化、版本的多处预览共用当前浏览器状态，不同版本独立；不假设跨设备同步。反馈不清空主输入框草稿，不创建新会话，运行中遵循原有队列。
- 新版必须显式声明 `initialState`；用户要求延续当前效果时，把相容状态映射进新版。历史反馈不能静默覆盖最新版本。
- 设计参数和反馈按需展开；放大、PNG 复制/下载、离线 HTML 由宿主统一操作。导出以当前预览状态生成，HTML 包含离线运行所需样式、声明的库与状态，不依赖 Host 连接或网络。
- iframe 没有剪贴板、下载、聊天或 Host 业务 API；不要添加 `piVisualize.export/copy/sendMessage` 等方法，也不要自行创建业务消息通道。

Agent 通过系统工具访问客户端当前状态或导出，先查询 `capabilities.describe`：

```js
// id、revision 必须来自当前分支真实可访问的引用。
system_read({ operation: 'visualizations.previewState', args: [{ id, revision }] })
system_write({ operation: 'visualizations.export', args: [{ id, revision }, { format: 'png' }] })
system_write({ operation: 'visualizations.export', args: [{ id, revision }, { format: 'html' }] })
```

两项均为 `scope: 'client'`，固定发起客户端并绑定执行会话，不取前台所选会话、不借另一窗口状态。读取返回 `{ reference, state, source }`，source 为 `live/saved/initial`，明确区分本地当前状态、已保存的浏览器状态和版本初值；读取不挂载面板，不触发聊天、重置或保存。

导出是写操作，沿用普通任务与完全权限要求，Plan 不能借它导出。PNG 需要本版已挂载且就绪的可见预览，否则返回 `not-loaded`，不会自动打开面板；HTML 可以使用当前浏览器可取得的状态生成。成功返回 `{ status: 'download-started', fileName, mimeType }`，只表示下载已发起，不返回本机路径，也不表示写入项目目录。细节以运行时 describe 为准。

无客户端、断线、不支持、引用不可访问或执行已取消时明确失败；不得用默认 `initialState` 冒充当前状态，不把失败当作空结果，不自动切换目标。

## 旧 Host 兼容与外部示例迁移

旧文档缺省 `layout/libraries` 时按常规布局与无附加库读取。`visualize-runtime-v2` 表示新版运行时能力；旧 Host 未声明时，客户端保留原有保存、读取与基础预览回退，不向它强发新操作。旧运行壳可能没有工具类、环境订阅或 ECharts，不以伪造桥接或网络脚本掩盖差异。需要兼容旧壳的片段按旧工具 schema 使用原生能力，否则说明需升级 Host。

| 外部示例                                   | pi-meme                                                    |
| ------------------------------------------ | ---------------------------------------------------------- |
| 本地 HTML 路径、其他产品内容引用           | `save_visualization` 与返回的 `visualize` 代码块           |
| `Tweak.addSelect/addSlider/...`            | 保存参数 `controls`                                        |
| `window.openai.widgetState/setWidgetState` | `piVisualize.getState/setState/subscribe`，状态保持扁平    |
| 环境全局事件                               | `getEnvironment/subscribeEnvironment`                      |
| `sendFollowUpMessage`                      | 用户提交宿主反馈；片段不自动聊天                           |
| 外部图表 `<script>`                        | `libraries: ['echarts']` 和 `createChart(element, option)` |
| 自带标题、导出、反馈工具栏                 | 宿主唯一标题、操作与按需展开区域                           |
| standalone 导出脚本                        | 宿主带当前状态的离线 HTML 导出                             |
