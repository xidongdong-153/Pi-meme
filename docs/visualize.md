---
description: '内置交互草图的工具、状态协议、预览与存储'
status: implemented
paths:
  - packages/visualize/src
  - packages/contracts/src/visualize.ts
  - pi/skills/visualize/SKILL.md
---

# 交互草图

visualize 是默认装配的内置能力。普通对话和 Plan 均可调用工具生成草图；保存草图不会实施业务代码。用户通过聊天确认设计。

每轮成功保存的草图紧跟对应工具活动显示，位于后续说明之前；codemode 等嵌套调用生成的草图放在承载它的外层工具活动之后。生成后无需展开工具活动或工作过程，轮次结束、收起过程和历史恢复后仍保留原位置。每个草图版本在该轮只展示一次，正文中重复的同版本引用不再重复渲染。计划正文可用 `visualize` 代码块引用 `{ "id": "草图 ID", "revision": 1 }`。当前分支有草图时，右侧工具目录显示“草图”；面板支持选择设计、版本和提交调整要求。

## 工具参数

`save_visualization` 接收完整版本，不接收 HTML 补丁。

| 参数           | 内容                                                      |
| -------------- | --------------------------------------------------------- |
| `title`        | 非空标题，最多 120 字符                                   |
| `description`  | 非空交互说明，最多 4000 字符                              |
| `html`         | 含内联 CSS、JS 的 HTML 片段，UTF-8 最大 1 MiB             |
| `initialState` | 一层 string、number、boolean 映射，UTF-8 JSON 最大 16 KiB |
| `controls`     | 最多 12 个设计控件                                        |
| `reference`    | 更新时提供 `{ id, revision }`；新建时省略                 |

每个控件包含 `key`、`label`、`type`。`key` 必须对应预先声明的状态键；键以字母开头，最多 64 字符，可包含字母、数字、下划线与连字符，不允许原型相关键。

| `type`   | 额外参数                                             | 状态值                    |
| -------- | ---------------------------------------------------- | ------------------------- |
| `select` | `options: [{ label, value }]`，1–12 项，value 不重复 | 选项字符串                |
| `toggle` | 无                                                   | boolean                   |
| `slider` | `min`、`max`、可选 `step`（默认 1）、`unit`          | 范围内且符合步长的 number |
| `color`  | 无                                                   | `#RRGGBB`                 |

`read_visualization({ reference })` 返回当前分支可访问的完整版本。保存返回固定版本引用和可嵌入计划的代码块。读取、修改和反馈均校验分支引用；普通消息文本不能授权读取草图。重试同一工具调用返回原版本，修改产生新版本；当前分支已有更新时拒绝过期基础版本。

## 状态与反馈

草图使用 `window.piVisualize`：

```js
const initial = window.piVisualize.getState()
const unsubscribe = window.piVisualize.subscribe((state) => render(state))
await window.piVisualize.setState({ compact: true })
```

首次渲染需读取 `getState()`；订阅回调不要重复写状态。`setState` 仅修改声明的键，返回 Promise；无效类型、选项或范围会拒绝。Host UI 控件与草图内部点击共用状态，同一会话同一版本的内联预览与右栏同步。

iframe 初始化检查父窗口来源和随机 token，再通过独立 MessageChannel 传递完整状态、递增序号、补丁请求、错误、主题和高度。草图只能访问模拟状态；不提供宿主业务调用。主题变量随宿主主题更新。

反馈提交包含草图 ID、版本和当时状态，走当前会话的提交守卫及队列。反馈不清空主输入框草稿，不创建新会话；接受后清空反馈框并跟随该设计的最新版本。历史消息保留原版本。用户可以在版本下拉中切回旧版本。

## 存储与隔离

- 正式产物：`<dataRoot>/state/modules/%40pi-meme%2Fvisualize/artifacts/<id>/<revision>.json`。每版保存元数据、控件、初始状态与 HTML，Host 串行写入并原子重命名。
- 临时会话：`<temporaryRoot>/visualize/<id>/<revision>.json`。关闭临时会话时随临时目录删除。
- 会话目录：从 Pi 原生消息树当前分支的成功工具结果投影，使用 entry ID 和 parent ID；压缩不会移除祖先引用。复制会话保留复制范围内的引用。
- UI 状态：浏览器 localStorage 按 Host、会话、草图和版本保存预览状态、反馈草稿；草图选择另行保存。不同浏览器不共享此状态，同一会话分支中引用相同版本时共用该预览状态。
- 反馈上下文：随队列保存，执行时再次验证，写入 Pi 自定义上下文 entry。

预览使用 `sandbox="allow-scripts"`，没有同源、弹窗、表单提交和宿主桥接权限。CSP 禁止联网及外部脚本、样式、字体；图片仅允许 data URI。它用于模拟交互，不是任意网页浏览器。正式产物当前不自动做孤立文件回收，删除会话后不应手动删除其他分支仍引用的版本。

## 修改位置与验证

- [契约](../packages/contracts/src/visualize.ts)：参数、控件校验、分支投影。
- [工具](../packages/visualize/src/agent/entry.ts)、[存储](../packages/visualize/src/server/store.ts)：Agent 工具与不可变版本。
- [预览](../packages/visualize/src/ui/visualization-preview.tsx)、[运行环境](../packages/visualize/src/ui/preview-runtime.ts)、[目录与面板](../packages/visualize/src/ui/use-visualizations.tsx)：渲染、设计控件、状态与反馈。
- [Host](../packages/host/src/service.ts)、[HostApi](../packages/host/src/app-control.ts)、[Worker](../packages/pi-adapter/src/session-worker.ts)：生命周期、存储选择与调用授权。
- [Pi 会话](../packages/pi-runtime/src/sdk/session.ts)、[聊天提交](../packages/chat/src/ui/use-chat-session.ts)：反馈上下文与队列。
- [App](../packages/app-ui/src/app.tsx)、[样式扫描](../packages/app-ui/src/global.css)：右栏入口与共享渲染上下文。
- [内置技能](../pi/skills/visualize/SKILL.md)：草图生成约束和状态用法。

针对性测试：

```bash
pnpm test --file packages/visualize/tests/store.integration.test.ts
pnpm test --file packages/host/tests/visualize.integration.test.ts
pnpm test --file packages/chat/tests/composer-submit.component.test.tsx
```

开发环境使用 `pnpm run start`。实机检查生成、四类控件、草图内点击、反馈更新、旧版切换、主输入框草稿保留及刷新恢复。
