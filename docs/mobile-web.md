---
description: '独立 Web 移动端模式的触发边界、页面展示、交互规则与日常维护指南'
status: implemented
paths:
  - apps/web/index.html
  - apps/web/src/app.tsx
  - packages/app-ui/src/app.tsx
  - packages/app-ui/src/global.css
  - packages/app-ui/src/layout/use-mobile-web.ts
  - packages/app-ui/src/layout/mobile-chat-shell.tsx
  - packages/app-ui/src/layout/mobile-session-drawer.tsx
  - packages/app-ui/src/layout/mobile-work-sheet.tsx
  - packages/app-ui/src/layout/workspace-content.tsx
  - packages/app-ui/src/settings/settings-page.tsx
  - packages/app-ui/src/shell/service-ui.ts
  - packages/app-ui/src/shell/services-app.tsx
  - packages/chat/src/ui/composer/composer.tsx
  - packages/chat/src/ui/composer/composer-editor.tsx
  - packages/chat/src/ui/composer/composer-toolbar.tsx
  - packages/chat/src/ui/composer/use-command-completion.ts
  - packages/chat/src/ui/conversation/assistant-turn.tsx
  - packages/chat/src/ui/conversation/chat-message.tsx
  - packages/chat/src/ui/conversation/conversation.tsx
  - packages/chat/src/ui/conversation/message-actions.tsx
  - packages/models/src/ui/model-picker-popover.tsx
  - packages/permissions/src/ui/agent-access-selector.tsx
  - packages/settings/src/ui/general-settings.tsx
  - packages/settings/src/ui/settings-page.tsx
  - packages/settings/src/ui/storage-settings.tsx
  - packages/settings/src/ui/theme-settings.tsx
  - packages/ui/src/components/settings.tsx
  - packages/workspace/src/ui/project-selector.tsx
---

# 移动端 Web

Pi meme 的移动端模式面向手机浏览器访问独立 Web（`apps/web`）的场景，采用与桌面端同构降维的「**双栏侧边抽屉 + 精简 Work 顶栏与输入区 + 轻量工作区产出 Sheet + 全页化设置**」结构，保留核心 Agent 工作流闭环并隐藏重度 PC 工作台界面。

## 触发边界与桌面隔离

- **生效条件**：仅当独立 Web 运行（`nativeWindow === false`）且视口满足 `(max-width: 767px)` 时进入移动端模式，实现见 [use-mobile-web.ts](../packages/app-ui/src/layout/use-mobile-web.ts)。
- **Desktop 不做响应**：Electron Desktop 传入 `nativeWindow = true`，`useMobileWeb(nativeWindow)` 恒返回 `false`。桌面窗口拖窄仍沿用既有桌面折叠与浮层逻辑，不进入移动端壳层。
- **不污染桌面偏好**：移动端通过独立的 [MobileChatShell](../packages/app-ui/src/layout/mobile-chat-shell.tsx) 渲染，不修改客户端保存在 `localStorage` 中的桌面 `sidebarLayout` 与 `workspaceView`（分栏／完整视图）偏好。浏览器宽度在 `767px <-> 768px` 切换时自动在全页设置与 `SettingsDialog` 之间无缝承接，会话状态与输入草稿保持不变。

## 页面结构与交互

### 1. 无硬边 52px 顶栏与状态条

由 [MobileChatShell](../packages/app-ui/src/layout/mobile-chat-shell.tsx) 渲染，高度 `52px` 并叠加顶部安全区 `env(safe-area-inset-top)`，仅在下方内容滚动穿过时显露细底线：

- **左侧**：统一使用 `PanelLeft` 侧栏开关（`40×40px` 热区）；聊天态下，当任意已连接服务存在等待用户输入／审批的会话时，按钮右上角显示提醒圆点。
- **中间**：
  - 新聊天首页：多服务时展示服务切换器，单服务时保持极简留白。
  - 已有对话态：显示单行截断的会话标题（归属项目时前置文件夹图标）。点击弹出快捷操作浮层，展示完整标题、所属项目，并提供「重命名会话」「置顶／取消置顶」「查看工作区产出」。
  - 设置态：左对齐紧邻 `PanelLeft` 显示当前设置分区标题。
- **右侧**：
  - 已有对话态：提供「工作区产出」按钮（存在计划、变更或来源时显示数量角标）与「新聊天」按钮。
  - 设置态：提供「完成」按钮返回聊天（存在未保存修改时触发离开确认）。
  - 新聊天首页：留空保持视觉平衡。
- **断线提示条**：仅连接断开或远程离线时在顶栏下方显示细状态条与「重试」入口。

### 2. 双栏复合侧边抽屉

由 [MobileSessionDrawer](../packages/app-ui/src/layout/mobile-session-drawer.tsx) 实现，总宽 `min(85vw, 336px)`，右侧配合半透明遮罩，支持点击遮罩、关闭按钮或按 `Escape` 关闭，关闭时设置 `inert` 与 `aria-hidden`：

- **左侧 `52px` 应用导航轨**：
  - 顶部：`PanelLeft` 收起按钮与「首页」入口。
  - 底部：
    - **用量入口**：点击弹出紧凑浮层展示今日、近 7 日与累计 Token 用量，并可直达设置「用量」页。
    - **头像菜单**：顶部名片展示头像、名称与连接状态（正常状态下连接状态的唯一展示位置，点击直达「个人资料」）；内嵌「跟随系统 / 浅色 / 深色」三态快切条；下方提供「用量」与「设置」入口。
- **右侧弹性上下文面板**：
  - **首页态**：顶部品牌标识、搜索会话与关闭按钮；轻量透明「新聊天」行；复用 `buildSidebarModel` 的「置顶 / 项目 / 最近」分组。项目行提供快捷「在该项目中新聊天」与 `···` 菜单（置顶、重命名）；会话行保留状态提示与单一 `···` 菜单（置顶、重命名、会话详情、带确认的删除会话）。首次加载期间展示骨架条。
  - **设置态**：当主画布处于全页设置时，右栏自动切换为 [SettingsDirectory](../packages/app-ui/src/settings/settings-page.tsx)（含 `autoFocus={false}` 药丸搜索框与分组目录），点选任意分区自动收起抽屉并切换内容。

### 3. 主会话区、对话操作与工作区产出 Sheet

由 [WorkspaceContent](../packages/app-ui/src/layout/workspace-content.tsx)、[Conversation](../packages/chat/src/ui/conversation/conversation.tsx)（传入 `mobile`）与 [MobileWorkSheet](../packages/app-ui/src/layout/mobile-work-sheet.tsx) 承载：

- **首页与全宽阅读**：首页去除重复品牌图标，仅展示居中标题（项目态支持点击项目名切换项目）。对话流在 `[data-mobile-web]` 下占满全宽并保留左右 `16px` 内边距；用户消息右对齐气泡，代码块与表格限制在各自容器内横向滚动。
- **显式移动端消息操作栏**：[ChatMessage](../packages/chat/src/ui/conversation/chat-message.tsx)、[AssistantTurnView](../packages/chat/src/ui/conversation/assistant-turn.tsx) 与 [MessageActions](../packages/chat/src/ui/conversation/message-actions.tsx) 在 `mobile = true` 时直接渲染常驻触控操作栏（用户消息保留「复制」与时间；AI 回复保留「复制」并将「从此处分叉」收口至 `···` 菜单），不再依赖 Hover。
- **轻量工作区产出 Sheet**：点击对话顶栏右侧产出按钮、[PlanCard](../packages/app-ui/src/panels/plan-card.tsx) 打开按钮、正文项目文件链接或 `+` 菜单「上下文用量」时，拉起上滑 [MobileWorkSheet](../packages/app-ui/src/layout/mobile-work-sheet.tsx)（支持半屏 `74dvh` 与全屏 `92dvh` 切换），按当前会话动态呈现「计划 / 变更 / 来源 / 文件 / 上下文」Tab，复用既有只读面板组件。

### 4. 底部输入卡、嵌套肩条与 `+` 动作菜单

- **统一吸底与软键盘跟随**：无论首页还是已有对话态，输入卡固定吸附视口底部并适配 `env(safe-area-inset-bottom)`；`useVisualViewportHeight` 同步软键盘可视高度，`useSyncThemeColor` 同步状态栏背景色。
- **首页嵌套肩条**：新聊天首页在悬浮输入卡正上方呈现左右内缩的嵌套肩条，承载 [ProjectSelector](../packages/workspace/src/ui/project-selector.tsx)（`mobile = true`）、计划模式快切、[AgentAccessSelector](../packages/permissions/src/ui/agent-access-selector.tsx)（`mobile = true`，保留完全权限确认与 Plan 只读锁定）及按需展示的技能选择；对话开始后肩条自动退场。
- **卡内状态芯片与 `+` 动作浮层**：[Composer](../packages/chat/src/ui/composer/composer.tsx) 与 [ComposerToolbar](../packages/chat/src/ui/composer/composer-toolbar.tsx) 在移动端开启计划模式或选择技能时，于输入框顶部展示可一键移除的胶囊芯片；点击左侧 `+` 展开向上动作菜单，统一收口「添加图片和文件」「计划模式」「访问权限」「选择技能」「上下文用量与压缩」。
- **回车换行、输入防缩放与去胶囊模型触发**：`ComposerEditor` 在 `mobile = true` 时 `Enter` 换行且字号固定 `16px`；[ModelPickerPopover](../packages/models/src/ui/model-picker-popover.tsx) 移动端触发器采用去胶囊轻触态，展示模型名、思考强度与 Fast 闪电标，点击弹出触屏滑块与 `44px` 行高列表。

### 5. 全页化设置与移动端裁剪

- 移动端进入设置后直接在 [MobileChatShell](../packages/app-ui/src/layout/mobile-chat-shell.tsx) 主画布全页渲染，复用 `useAppNavigation` 的设置路由与未保存离开确认；抽屉右栏自动作为设置目录。
- `[data-mobile-web] .mobile-settings-page` 下通过 [settings.tsx](../packages/ui/src/components/settings.tsx) 原语类名自动扁平化分组细线、放大行高与药丸控件，所有文本输入保持 `16px`。
- **移动端设置裁剪**：隐藏桌面独占的「快捷键」「电脑操控」以及「常规」中的本机目录路径更改、「外观」中的桌面视图切换与打开主题目录；「浏览器」仅在存在可用浏览器平台时显示；「外观」升级为三列等宽预览卡片并将低频项折叠进「高级外观」。

### 6. 能力边界（保留 vs 仅限 PC 端）

| 区域     | 移动端 Web 保留                                                                        | 仅限 PC 端（移动端不呈现）                                         |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 导航壳层 | 双栏复合抽屉（52px 轻轨 + 上下文右栏）、52px 无硬边顶栏、全出血画布                    | 常驻固定三栏、圆角外框留白、前进／后退按钮                         |
| 侧栏能力 | 搜索会话、新聊天、项目快捷新聊天、会话置顶／重命名／删除／详情、用量概览、主题快切     | 悬停预览卡、拖拽排序、在本地应用打开目录、新建本机项目目录         |
| 工作产出 | 上滑 `MobileWorkSheet`（计划、变更、来源、文件只读预览、上下文）、Agent 提问／审批     | 常驻右侧分栏与完整视图标签、终端、侧边聊天、文件编辑树             |
| 输入控制 | 首页嵌套肩条、`+` 动作菜单（附件、Plan、权限、技能、上下文压缩）、去胶囊模型与思考强度 | Goal 控制、Git 分支与 Worktree、桌面 `@`/`/` 键盘补全浮层          |
| 设置与页 | 全页化设置（14~15 项移动端可用分区，含外观三列卡片与高级折叠）、登录页                 | 快捷键录制、电脑操控、本机存储目录迁移、资料空间／定时任务等 P2 页 |

## 维护指南

后续迭代聊天、输入区、模型选择或新增桌面功能时，请遵守以下约束，避免破坏移动端体验或反向污染 Desktop：

1. **所有移动端分支通过 `mobile?: boolean` 可选注入**：共享业务组件（`packages/chat`、`packages/models`、`packages/workspace`、`packages/permissions`、`packages/settings`）默认 `mobile = false`，严禁在底层组件里自行读取 `window.innerWidth` 或 `matchMedia` 决定行为，否则会导致 Electron Desktop 缩窄窗口时意外触发移动端 UI。
2. **移动端样式必须收口在 `[data-mobile-web]` 作用域下**：在 [global.css](../packages/app-ui/src/global.css) 中针对移动端的覆盖规则不要直接写成全局 `@media (max-width: 767px)`，必须挂载在 `[data-mobile-web]` 选择器下，确保仅独立 Web 移动端生效。
3. **禁止在移动端弹层与抽屉中自动聚焦搜索框**：给 `Popover` / `Dialog` / 设置目录新增搜索输入时，必须设置 `autoFocus={false}`（或 `autoFocus={!mobile}`），防止弹出软键盘遮挡选项列表。
4. **保持移动端文本输入字号 `>= 16px`**：移动端可见的 `<input>`、`textarea` 与 `contenteditable` 编辑区须保持 `16px`（`text-base`），避免 iOS Safari 聚焦时自动放大视口。
5. **维护回车换行与已读同步**：修改 `ComposerEditor` 或 `useCommandCompletion` 的键盘事件时，保留 `mobile` 下 `Enter` 换行且不触发表单提交；修改 `app.tsx` 可见性逻辑时，保持 `chat.setReadVisible` 在 `mobileWeb` 下随 `!settingsOpen` 生效。
6. **无 Hover 交互兜底**：对话区、抽屉列表与设置页新增面向移动端可见的操作按钮时，不能仅靠 `opacity-0 group-hover:opacity-100` 显隐，并保持可触控热区（`>= 36×36px`，列表行 `>= 44px`）。
