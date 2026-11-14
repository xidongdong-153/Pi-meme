---
description: '内置可视化的图表、交互讲解、模拟、UI 预览与状态、导出协议'
status: implemented
paths:
  - packages/visualize/src
  - packages/contracts/src/visualize.ts
  - pi/skills/visualize/SKILL.md
---

# 可视化

visualize 是默认装配的内置能力，用于在对话和 Plan 中展示图表、交互讲解、模拟与 UI 预览。图内操作只改变演示状态，不自动发起聊天，不实施业务代码。真实数据注明来源，示例数据和简化模型说明边界。

## 展示与操作

成功保存的可视化紧跟对应工具活动显示；codemode 等嵌套调用的结果放在承载它的外层活动之后。收起过程、轮次结束和历史恢复后仍保留位置，同一版本在该轮只展示一次。计划正文可用工具返回的 `visualize` 代码块引用 `{ "id": "可视化 ID", "revision": 1 }`。当前分支有内容时，右侧工具目录显示“可视化”，支持选择内容和历史版本。

宿主提供唯一标题和操作区，片段不重复标题、版本栏或工具栏。常规内联最大宽度 736px，`wide` 布局最大 1024px；实际宽度受聊天区域限制，两者都需适配 320px。顶层透明无框，空间不足时换行或堆叠。放大视图共用同一版本和状态，不生成新产物。

“设计参数”和“调整要求”按需展开，不常驻占用画面；没有设计控件时不显示空参数区。重置恢复本版初始状态。用户提交调整要求才进入当前会话，附带真实引用和提交时状态；主输入框草稿保留，运行中沿用提交守卫与队列。接受后清空反馈并跟随该内容的最新版本，历史消息仍指向旧版。

操作区提供复制 PNG、下载 PNG 和导出 HTML。PNG 来自当前画面；离线 HTML 包含片段、当前状态、主题、统一运行时及声明的库，离开 Host 后仍可交互，无需网络。系统字体仍由打开文件的设备提供。浏览器拒绝剪贴板或不支持图片复制时显示原因，可改用下载 PNG；不在 iframe 内提供第二套复制、下载或业务 API。

PNG 由 iframe 内的 html-to-image 1.11.13 捕获内容，宿主编码，最长边限制为 4096px，单次操作超时为 10 秒；宿主菜单和反馈框不进入图像。失败保留当前内容，可重试。预览按内容测高，最高 16384px；长内容优先分页或筛选，不依靠内框滚动承载整页。

## 保存与读取

`save_visualization` 接收完整版本，不接收 HTML 补丁；`read_visualization({ reference })` 读取当前分支可访问的完整保存版本。

| 参数           | 内容                                                           |
| -------------- | -------------------------------------------------------------- |
| `title`        | 非空标题，最多 120 字符；由宿主显示                            |
| `description`  | 非空说明，最多 4000 字符；关键交互、数据来源或模拟边界         |
| `html`         | 含内联 CSS、JS 的 HTML 片段，UTF-8 最大 1 MiB                  |
| `initialState` | 一层 string、有限 number、boolean 映射，UTF-8 JSON 最大 16 KiB |
| `controls`     | 最多 12 个设计控件；无需参数时传 `[]`                          |
| `reference`    | 更新时提供 `{ id, revision }`；新建时省略                      |
| `layout`       | 可选 `'regular'` 或 `'wide'`，省略为常规布局                   |
| `libraries`    | 可选 `['echarts']`；省略或 `[]` 使用原生能力                   |

状态保持扁平，不接受数组、嵌套对象或 null。键以字母开头，最多 64 字符，可包含字母、数字、下划线与连字符，拒绝原型相关键。每个控件包含 `key/label/type`，key 必须唯一且对应预先声明的状态键。

| `type`   | 额外参数                                             | 状态值                             |
| -------- | ---------------------------------------------------- | ---------------------------------- |
| `select` | `options: [{ label, value }]`，1–12 项，value 不重复 | 选项字符串                         |
| `toggle` | 无                                                   | boolean                            |
| `slider` | `min/max`、可选 `step`（默认 1）、`unit`             | 范围内且符合从 min 起步长的 number |
| `color`  | 无                                                   | `#RRGGBB`                          |

保存返回固定版本引用和可嵌入计划的代码块。读取、修改和反馈都校验执行会话的分支引用；普通消息写出 ID 不构成读取授权。同一工具调用重试返回原版，修改产生新版本；分支已有更新时拒绝过期基础版本。不要删除 `reference` 绕过冲突。

`read_visualization` 返回的 `initialState` 是保存时的默认状态，不是用户当前选择。更新时显式提供新版初值；需要延续当前效果时，使用反馈状态或客户端状态读取结果，只映射仍相容的键。

## 统一运行时

片段使用原生 HTML/CSS/SVG/Canvas，不依赖项目 React、Tailwind、远程字体或 CDN。CSS 和查询以唯一根 ID 为作用域；脚本直接初始化，不等待 `DOMContentLoaded`。基础控件和常用布局由运行时统一提供，不重写它们的外观和焦点样式。

| 用途       | 工具类与约定                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------- |
| 按钮       | `.btn`、`.btn-primary`、`.btn-ghost`                                                            |
| 表单       | `.form-control`、`.form-select`、`.form-range`、`.form-check`、`.form-switch`                   |
| 布局与摘要 | `.card`、`.viz-grid`、`.viz-row`、`.viz-controls`、`.viz-stat`、`.viz-stat-value`、`.viz-badge` |
| 表格与文字 | `.table`、`.text-small`、`.text-muted`、`.tabular-nums`、`.sr-only`                             |
| Tab        | `.nav` / `.nav-pills`、`.nav-link` 与 ARIA Tab 关系，自动处理点击和键盘切换                     |
| 提示与图标 | `data-tooltip`、`data-lucide`；保留必要标签和无障碍名称                                         |

主题提供 `--font-size-base` 与 `--background/--foreground`、`--card/--card-foreground`、`--muted/--muted-foreground`、`--primary/--primary-foreground`、`--accent/--accent-foreground`、`--border` 等颜色变量。图形系列用 `--viz-series-1` 到 `--viz-series-6`，单系列优先使用第一色，固定类别保持映射；轴、标签和结构线保持中性色。颜色是完整 CSS 值，直接写 `var(--foreground)`，不包 `hsl()`。

`window.piVisualize` 提供：

| 方法                             | 作用                                     |
| -------------------------------- | ---------------------------------------- |
| `getState()`                     | 读取当前完整状态副本                     |
| `setState(patch)`                | 提交声明键的补丁，返回完整状态的 Promise |
| `subscribe(listener)`            | 订阅完整状态，返回取消函数               |
| `getEnvironment()`               | 读取当前环境快照                         |
| `subscribeEnvironment(listener)` | 订阅环境，返回取消函数                   |
| `createChart(element, option)`   | 声明 `echarts` 后创建并返回 ECharts 实例 |

首次渲染主动读取状态；订阅回调只重绘，不再次写状态。`setState` 不增加或删除键，不改变类型，合并后继续校验控件选项、范围和步长；拒绝时片段显示简短错误。片段按钮和宿主设计参数共用状态，同一会话同一版本的内联、右栏和放大视图同步。

同一帧内的连续补丁合并发送，同键使用最后提交的值，各次调用的 Promise 返回该批次确认后的完整状态。宿主按帧通知其他视图并合并持久化写入；切换展示位置不重置状态。

环境包含 `appearance`（light/dark）、`reducedMotion`、`visible`、`fontFamily`、`fontSize`、`radius` 和 `colors`。环境来自宿主，不能通过状态补丁修改。CSS/SVG 跟随变量，Canvas 在环境变化时重绘；减少动态效果时直接呈现结果，不可见时停止动画和无用绘制。环境颜色可供命令式绘图使用，字号和圆角跟随宿主。

Tab 按 `tablist/tab/tabpanel`、`aria-controls/aria-labelledby` 关联。运行时管理键盘焦点和面板切换，并从选中 Tab 发出冒泡 `tabchange`，`event.detail.value` 为 `data-tab` 值或面板 ID。片段监听该事件提交选中值，在状态订阅中同步选中属性与 `hidden`，使鼠标和键盘选择都能恢复；不重复监听方向键。提示不承载必读信息，图标不替代可访问名称。

### ECharts

保存时声明 `libraries: ['echarts']`，由宿主离线加载。`createChart(element, option)` 接受标准 ECharts option，默认 SVG、宿主主题和自动 resize，返回实例供 `setOption/on/off/resize/dispose` 使用。`dataset/series/xAxis/yAxis` 等数据直接按 ECharts 格式传入，不另建数据 schema；数据集留在片段内，状态仅保存筛选、选择或参数等标量。

容器需有可测量高度，更新数据复用实例；隐藏面板显示后必要时调用 `resize()`。不添加 option `title` 或 `toolbox.saveAsImage` 来重复宿主标题和导出操作。

## Agent 读取状态与导出

保存源码和浏览器预览状态分别有来源。`visualizations.list/read` 读取 Host 保存产物；以下操作均为 `scope: 'client'`，固定发起客户端并绑定执行会话：

```js
system_read({ operation: 'visualizations.previewState', args: [{ id, revision }] })
system_write({ operation: 'visualizations.export', args: [{ id, revision }, { format: 'png' }] })
system_write({ operation: 'visualizations.export', args: [{ id, revision }, { format: 'html' }] })
```

调用前用能力目录和 describe 确认支持与参数。引用必须在执行会话当前分支可访问，不接受任意会话、客户端 ID、路径或前台选择替代目标。读取返回 `{ reference, state, source }`，source 区分 `live/saved/initial`；未打开预览时不会为了读取挂载面板，初始值必须明确标注为 `initial`，不能描述成用户已操作的状态。

导出沿用普通任务与完全权限要求，Plan 可保存可视化但不能使用系统写操作。PNG 需要该版本已挂载并就绪的可见预览，未加载返回 `not-loaded`，不自动打开面板；HTML 可使用当前浏览器可取得的状态生成。成功结果为 `{ status: 'download-started', fileName, mimeType }`，只表示发起客户端下载，不表示文件已写入指定磁盘目录。复制 PNG 由用户通过宿主操作发起，不新增 iframe API。

Host 先校验执行会话、临时会话归属和分支访问，再向固定客户端委托；连接、注册或执行代次过期时失败，不借另一窗口或其他会话的状态，不自动重放。无客户端、断线和不支持均返回实际原因，不以默认值冒充当前用户状态。完整系统权限与路由见 [Host 内置工具](host-system-tools.md#可视化)。

## 存储、隔离与兼容

- 正式产物：`<dataRoot>/state/modules/%40pi-meme%2Fvisualize/artifacts/<id>/<revision>.json`，保存元数据、控件、初始状态、布局、库声明和 HTML；Host 串行写入并原子重命名。
- 临时产物：`<temporaryRoot>/visualize/<id>/<revision>.json`，关闭临时会话时随目录删除。
- 会话目录：沿 Pi 原生 entry ID 与 parent ID 祖先链读取顶层成功工具结果，以及内置扩展补存的结构化嵌套结果；压缩保留祖先引用，复制会话保留复制范围内引用。
- UI 状态：宿主 UI 在当前浏览器按 Host、会话、可视化和版本保存状态与反馈草稿，选择另行保存；片段不直接使用 localStorage，不假设跨设备共享。
- 反馈上下文：随队列保存，执行时再次验证，写入 Pi 自定义上下文 entry。

预览使用 Host 固定 `/visualization-preview` 运行壳，不把会话数据放入公共响应。初始化校验父窗口、随机 token 和独立消息端口；HTML、状态、环境和所需运行时资产随后经端口传入。运行时资产与 Host/客户端一同分发，ECharts 按声明加载，捕获资源按导出需要加载，不走外部网络。

iframe 和预览响应均使用 `sandbox allow-scripts`，没有同源、弹窗、表单提交或宿主业务权限。CSP 禁止联网、外部脚本、样式和字体，图片仅内嵌 data URI；只有预览壳允许所需内联脚本，应用页面策略不变。片段不访问文件、凭据、真实业务接口或宿主 DOM，不自动发送聊天。预览启动超时或脚本错误显示原因，可重新加载并保留状态与反馈草稿。

`visualize-runtime-v2` 表示 Host 支持统一运行壳和新增能力。连接旧 Host 时保留原有保存、读取与基础预览回退，不发送它未声明的新操作，也不假装有环境 API、ECharts 或导出。旧版本缺少 `layout/libraries` 时按常规布局和无附加库处理；依赖新运行时的片段需升级 Host，不通过 CDN 或伪造桥接补齐。正式产物不自动做孤立文件回收，删除会话后不手动删除其他分支仍引用的版本。

## 创作参考与修改入口

内置技能按需提供 [波纹花园](../pi/skills/visualize/references/ripple-garden.md)、[常用图表](../pi/skills/visualize/references/charts.md)、[UI Tab](../pi/skills/visualize/references/ui-tabs.md) 与 [任务卡片](../pi/skills/visualize/references/task-card.md) Markdown 示例，可直接改写后交给保存工具；它们不作为测试或验收证据。

- [契约](../packages/contracts/src/visualize.ts)：参数、控件、环境和客户端操作。
- [工具](../packages/visualize/src/agent/entry.ts)、[存储](../packages/visualize/src/server/store.ts)：完整版本与访问授权。
- [运行壳](../packages/visualize/src/shared/preview-page.ts)、[运行时](../packages/visualize/src/runtime)：统一工具类、交互与图表。
- [预览](../packages/visualize/src/ui/visualization-preview.tsx)、[目录](../packages/visualize/src/ui/use-visualizations.tsx)：内联、放大、设计参数与反馈。
- [状态](../packages/visualize/src/ui/visualization-state.ts)、[导出](../packages/visualize/src/ui/visualization-export.ts)：共享预览状态、PNG 与离线 HTML。
- [Host 系统操作](../packages/host/src/system-operations.ts)、[客户端路由](../packages/app-ui/src/session/use-system-client.ts)：权限、执行身份与客户端范围。
- [内置技能](../pi/skills/visualize/SKILL.md) 与 [状态协议](../pi/skills/visualize/references/protocol.md)：生成约束和完整调用写法。

功能验收须由未编写实现的 Hacker 使用真实生成、状态交互、环境切换、窄宽度、反馈、导出与旧 Host 路径完成，并记录 oracle 与人员；静态检查、示例或工具保存成功都不能代替。当前文档不宣称已完成这些验收。
