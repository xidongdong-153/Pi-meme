# 工具与状态协议

这里描述 pi-meme 当前实现。参考其他环境的示例时，以本协议为准。

## 保存和读取

`save_visualization` 参数：

| 字段           | 必填 | 约束                                                                        |
| -------------- | ---- | --------------------------------------------------------------------------- |
| `title`        | 是   | 非空字符串，最多 120 字符                                                   |
| `description`  | 是   | 非空字符串，最多 4000 字符；说明关键交互与模拟边界                          |
| `html`         | 是   | 非空 HTML 片段，UTF-8 最大 1 MiB；包含所需内联 CSS、JS                      |
| `initialState` | 是   | 一层 JSON 对象，值仅为 string、有限 number、boolean；UTF-8 JSON 最大 16 KiB |
| `controls`     | 是   | 数组，最多 12 项；无设计控件时传 `[]`                                       |
| `reference`    | 否   | 修改已有设计时必填 `{ id, revision }`，新建时省略                           |

状态可以为空对象。键必须匹配 `^[a-zA-Z][\w-]{0,63}$`，不能是 `constructor`、`prototype` 或 `__proto__`；建议使用 camelCase。数组、嵌套对象、`null`、`NaN`、`Infinity` 均不能作为状态值。

每个控件包含非空 `label`、唯一 `key` 和 `type`；`key` 必须存在于 `initialState`。总数限制按整份草图计算，不是每个组件各 12 项。只提供对应类型需要的字段。

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

- `select`：1–12 项，`label`、`value` 为字符串，value 不重复；初值与运行时值都必须对应选项。
- `toggle`：值必须为 boolean，不用字符串 `"true"` 或数值代替。
- `slider`：`min < max`；`step` 默认为 1 且必须大于 0。值在范围内，并满足从 min 起的步长；`unit` 只用于显示，不写进状态数值。
- `color`：六位十六进制 `#RRGGBB`，不使用短色值、命名色或透明度。

保存成功返回文本中的固定版本代码块和结构化 `details.visualization` 引用。不要自行生成 ID 或递增版本号。读取使用 `read_visualization({ reference: { id, revision } })`，返回完整文档，包含源码、状态、控件及版本元数据。

更新时只提交工具接受的业务字段和 `reference`，不把读取结果中的 `schemaVersion`、`createdAt`、`callId`、顶层 `id`、`revision` 混进保存参数。版本不可变，旧消息仍引用旧版。同一工具调用重试幂等；当前分支存在更新版本时，旧基础版本保存会被拒绝。

## 浏览器状态 API

| 方法                  | 返回                      | 用法                          |
| --------------------- | ------------------------- | ----------------------------- |
| `getState()`          | 当前完整状态的副本        | 首次渲染、读取当前值          |
| `setState(patch)`     | Promise，成功返回完整状态 | 提交一个或多个声明键的变化    |
| `subscribe(listener)` | 取消订阅函数              | 接收完整状态，更新 DOM 和样式 |

宿主在执行片段脚本前完成初始化。不要创建 fallback 状态桥接来隐藏宿主不可用的问题。

`setState` 是补丁而非整个状态替换；省略的键保留原值。不能增加、删除键或改变既有值类型。宿主先验证补丁合并后的状态，再同步同一版本的预览，并回复请求。不要假设提交后立即调用 `getState()` 就已更新，使用订阅回调或 `await setState(...)` 的结果。

```js
const root = document.getElementById('task-preview')
const api = window.piVisualize

function render(state) {
  root.querySelector('[data-stage]').textContent = state.stage === 'done' ? '已完成' : '待处理'
}

render(api.getState())
const unsubscribe = api.subscribe(render)
root.querySelector('button').addEventListener('click', async () => {
  try {
    await api.setState({ stage: 'done', progress: 100 })
  } catch (error) {
    root.querySelector('[role="alert"]').textContent = `更新失败：${error.message}`
  }
})
```

上段需配合包含对应元素的 HTML；可直接改写的完整片段见 [任务卡片示例](task-card.md)。只有组件被动态移除而页面仍存活时，才需要调用其 `unsubscribe()` 并清理组件计时器、监听器。

## 状态、版本与反馈的区别

- 点击和设计控件只改变预览状态，不保存设计新版本，不自动给模型发送消息。
- 状态和反馈草稿由宿主在当前浏览器保存。同一 Host、会话、草图、版本的多处预览共享状态；不同版本独立，不假设跨设备共享。
- 点击宿主反馈“发送”才发起聊天；消息附带真实引用及提交时状态。调整要求进入当前会话，运行中可排队，主输入框草稿保留。
- 保存新版仍须显式提供新版 `initialState`。已有预览状态不会自动成为新版本的初值；用户要求延续当前效果时自行映射并验证。
- 用户可从历史版本反馈。以用户要求为准判断是迁移修改到最新设计，还是另建独立方案，不静默覆盖其他修改。

## 与参考环境的差异

| 参考示例中的能力                           | pi-meme 的写法                                   |
| ------------------------------------------ | ------------------------------------------------ |
| 本地 HTML 路径与专用内容引用               | `save_visualization` 和返回的 `visualize` 代码块 |
| `Tweak.addSelect/addSlider/...`            | 保存参数 `controls`                              |
| `window.openai.widgetState/setWidgetState` | `window.piVisualize` 三个方法                    |
| `sendFollowUpMessage`                      | 用户通过宿主反馈框发送；片段无发送消息 API       |
| 自动轮播、Tab、Tooltip、日历               | 未提供；确有需要时自行实现局部产品交互           |
| CDN、外部样式、工具类、全局 Lucide         | 未提供；使用内联 CSS、原生 JS 和必要的 SVG       |
| standalone 导出脚本与发布                  | 保存工具不提供这些能力，不能直接套用参考脚本     |
