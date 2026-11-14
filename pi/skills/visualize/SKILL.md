---
name: visualize
description: 在对话或计划中生成、调整图表、交互讲解、模拟和 UI 预览。用于查看数据关系、探索参数影响、理解动态过程或比较界面方案；用户要求实现项目或交付正式文件时，继续完成对应任务。
---

# 可视化

使用 `save_visualization` 保存 HTML 片段、初始状态和可选设计控件。普通任务和 Plan 均可使用；图内操作只改变演示状态，保存可视化不代表获准实施业务代码。宿主提供唯一标题、版本、放大、重置、导出，以及按需展开的设计参数和反馈。

## 选择表达方式

- 数据的趋势、分布、组成或相关性适合图表。简单图形用原生 HTML/CSS/SVG/Canvas；需要坐标轴、图例、缩放或多系列时，声明 `libraries: ['echarts']` 并使用标准 ECharts option。
- “如何工作”“改变这个会怎样”“帮我理解”适合交互讲解或模拟：让一个主要画面响应少量有意义的操作，避免把讲解变成控制台。
- 页面、组件、布局和产品流程适合 UI 预览，沿用用户参考与产品语义；用户要求正式实现时，继续完成项目任务，不自行增加设计审批步骤。
- 一句话、Markdown 表格或静态结构图已足够时直接使用。科学绘图、出版图或要求可编辑源文件时，按目标格式制作，不能只交付内联预览。
- 真实数据注明来源；示例数据、模型简化与模拟边界放在 `description` 或必要的正文中，不编造统计结论。

首次生成前阅读 [工具、运行时与状态协议](references/protocol.md)。按本次任务选择参考，不必全部加载：

- [波纹花园](references/ripple-garden.md)：可直接改写的 SVG 形态模拟，包含公式、状态、环境变化和有限过渡。
- [常用图表](references/charts.md)：标准 ECharts option、交互状态与常用图形选择。
- [UI Tab 预览](references/ui-tabs.md)：统一工具类、自动键盘 Tab 和持久状态绑定。
- [任务卡片](references/task-card.md)：四类宿主设计控件和原生产品按钮共用状态。

## 保存与修改

1. 确定用户需要看清或尝试的关系，只保留必要数据、标签和操作。
2. 在 `initialState` 预先声明需要恢复、同步或用于后续讨论的标量。图表数据留在片段常量中，不把数组、嵌套对象或 ECharts option 塞入状态。
3. 写完整片段；先读取 `getState()` 渲染，再订阅状态。环境变化通过 `getEnvironment()` 和 `subscribeEnvironment()` 处理。
4. 需要较宽布局时传 `layout: 'wide'`，其他情况省略或使用 `'regular'`。常规内联上限 736px，宽布局上限 1024px；两者都支持 320px，不能靠放大才可操作。
5. 用 `save_visualization` 保存完整版本。`controls` 无需设计参数时传 `[]`；`description` 简述关键交互、数据来源或模拟边界。

修改已有可视化时，从真实反馈或工具结果取得 `{ id, revision }`，先调用 `read_visualization({ reference })`。只改用户要求的内容，保留布局、状态、控件、`layout` 和 `libraries` 中仍适用的选择，提交完整新版和基础版本 `reference`。不要猜 ID、手动递增版本、删除引用绕过冲突或因生成时间较晚而改错目标。

区分默认状态和当前预览状态。需要延续用户选择时，使用反馈附带的状态，或在可用时通过客户端范围的 `system_read` 操作 `visualizations.previewState` 读取；原始版本中的 `initialState` 不是用户当前状态。不可访问、断线、取消或版本冲突时说明实际原因；不擅自落盘工作区 HTML 来冒充保存成功。

## 构图与文案

- 顶层透明、无框、无外层卡片，不重复 `title`，不添加副标题或实施说明。坐标轴、图例、控件标签、错误与无障碍文本保留。
- 一个主要画面配必要操作。指标仅在帮助解释当前行为时出现；不要用无关 KPI、装饰图标、重复图例和说明填充空间。
- 设计参数与“调整要求”由宿主按需展开，片段只保留内容本身需要的交互。不要另造版本栏、宿主标题、反馈输入框、复制、下载或放大按钮。
- 图表、表格和解释画面不套卡片。确需摘要或有边界的产品字段时用 `.card`，不嵌套，不为普通分组添加填色、边框、阴影。
- UI 预览遵循真实产品层级；组件不补造应用外壳。流程按钮明确表达模拟的状态变化，不提交真实任务、支付或删除。

## 统一样式与交互

运行时提供以下工具类；优先组合，不复制或覆盖它们的外观与焦点样式：

| 用途       | 工具类与约定                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| 按钮       | `.btn`，配 `.btn-primary` 或 `.btn-ghost`                                                               |
| 原生表单   | `.form-control`、`.form-select`、`.form-range`、`.form-check`、`.form-switch`                           |
| 布局与摘要 | `.card`、`.viz-grid`、`.viz-row`、`.viz-controls`、`.viz-stat`、`.viz-stat-value`、`.viz-badge`         |
| 表格与文字 | `.table`、`.text-small`、`.text-muted`、`.tabular-nums`、`.sr-only`                                     |
| Tab        | `.nav` / `.nav-pills`、`.nav-link` 与 `tablist/tab/tabpanel`、`aria-controls`；运行时提供点击和键盘切换 |
| 提示与图标 | `data-tooltip="短提示"`、`data-lucide="图标名"`；图标按钮仍需可访问名称                                 |

自定义 CSS 只处理根 ID 下的布局和专属绘图元素。让控件自动换行，窄宽度改为堆叠；避免固定外宽、`100vh`、固定定位工具栏、整幅等比缩小和内部滚动。表格列确实无法折行时才局部横向滚动。宿主按内容测高，画布可以有合理的局部高度。

- 使用 `var(--font-size-base)` 缩放间距与图形标注，继承宿主字体。次要文字用 `.text-small` / `.text-muted`，变化数字用 `.tabular-nums`，不用小字掩盖溢出。
- 颜色变量是完整 CSS 颜色，直接使用 `var(--foreground)`，不再包 `hsl()`。`--muted` 是表面，次要文字用 `--muted-foreground`。
- 单系列和主要数据标记用 `--viz-series-1`，重要的其他系列用 `--viz-series-2` 到 `--viz-series-6`。映射保持稳定；轴、文字与网格使用前景色或中性色，颜色不能成为唯一标识。
- 环境提供 `appearance/reducedMotion/visible/fontFamily/fontSize/radius/colors`；CSS/SVG 跟随主题变量，Canvas 在环境变化时重绘。`reducedMotion` 为真时直接更新状态，`visible` 为假时停止动画，不在后台持续绘制。
- 原生控件关联标签，按钮指定 `type="button"`，图标按钮加 `aria-label`。保留键盘焦点；Tab 交给运行时，不重复绑定方向键或自行维护第二套 Tab 状态。
- 可交互图形提供键盘或原生控件的等价入口。动态结果可用 `aria-live="polite"`，错误用 `role="alert"`，不播报每帧动画或 hover。

## 状态与运行边界

- `window.piVisualize.getState/setState/subscribe` 是唯一共享状态入口；片段内控件与宿主设计参数读写同一份状态。`setState` 返回 Promise，捕获拒绝并显示简短错误。
- 渲染和订阅只更新画面，不再次写状态。一次操作影响多个值时提交一个补丁。DOM、图表实例、计时器、hover 和可推导数据留在本地。
- 自动 Tab 更新面板可见性；在运行时发出的 `tabchange` 中只提交选中值，订阅中同步选中属性和面板。用原生 `hidden` 保留其他面板内容，避免切换后丢失编辑状态。
- HTML 是带内联 `<style>` / 普通 `<script>` 的片段，不写文档外壳。使用唯一根 ID、局部脚本作用域，不等待 `DOMContentLoaded`，不依赖 `document.currentScript`。
- 原生 HTML/CSS/SVG/Canvas 可直接使用。仅 `libraries: ['echarts']` 声明后可调用 `piVisualize.createChart(element, option)`，返回 ECharts 实例；默认 SVG、宿主主题和自动 resize。数据使用标准 ECharts option，不创建私有图表数据协议。
- 不加载网络、CDN、外部脚本、字体或样式；没有 React、D3、`Tweak` 或 `window.openai`。图片仅用已有的内嵌数据。不访问文件、凭据、真实业务接口或 iframe localStorage。
- 不创建宿主桥接、伪造父窗口消息、访问宿主 DOM。iframe 没有导出、剪贴板、聊天或其他业务 API。图内动作仅更新状态，不自动发起聊天；只有用户提交宿主反馈才进入对话。

宿主负责 PNG 复制/下载和带当前状态的离线 HTML。Agent 需要导出时，先查询能力目录，再用客户端范围的 `system_write` 操作 `visualizations.export`；写权限遵循现有完全权限要求。旧 Host 缺少新增能力时走原有保存/读取和预览回退；不伪造 API 或改用 CDN。详细参数与兼容边界见协议。

## 输出

保存前核对状态类型、控件范围、DOM 引用、离线依赖和 320px 布局设计。源码检查只说明检查了源码；工具成功只表示已保存，不能当成真实交互验收。

本轮成功保存的可视化会紧跟对应工具活动直接渲染，不随过程折叠；普通回复不必重复嵌入。计划正文或确需引用时使用工具返回的 `visualize` 代码块，保留真实 ID 和版本，不贴完整源码、本地路径或其他产品的渲染指令。正文只补充用户需要的结论或关键操作，不复述可见内容。
