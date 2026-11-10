# Bots

独立的个人助理服务与 Web，支持角色 Bot、私聊、群聊、协作、定时任务、资料、多 Host 委派和 QQ 官方机器人私聊。模型、凭据和数据由 Bots 自己维护。

需要 Node.js **24.14.0 或更高版本**、pnpm **10.29.1**。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build:bot
pnpm serve:bot
```

打开 `http://127.0.0.1:4310`，首次依次设置访问密码、填写对话模型、点击“验证并开始”进入默认助理私聊。该按钮保存候选配置、实际验证图片输入和安全工具调用，再激活默认模型。验证会调用供应商并可能计费，失败后候选及非敏感输入可继续编辑。预置服务最多手填模型 ID 与密钥，自定义兼容服务补充地址。

创建 Bot 只需名称和职责，模型默认继承，创建时原子建立固定 Web 私聊。群组支持稳定成员 ID 与本群协作授权。主界面采用左侧 Bot/群组列表和右侧聊天，标题打开详情，编辑替换同层内容。设置从左下头像菜单进入，模型、记忆与定时任务在同层编辑。Host、QQ 和独立生图模型按需配置。

开发时，在两个终端分别运行：

```bash
pnpm start:bot
```

```bash
pnpm dev:bot
```

Web 开发入口是 `http://127.0.0.1:4311`。`start:bot` 启动源码服务；`dev:bot` 启动 Vite 并代理 `/api`，两者均不启动工作台 Host。4310 提供上一次 `build:bot` 生成的页面；修改 UI 时用 4311 热更新，或重新构建后在 4310 刷新。

Web UI 在 [src/ui](src/ui) 维护 DS-Bot 布局、主题 token、业务状态与动效，Select、Button、Input、Textarea、Tooltip、DropdownMenu 按 `@pi-meme/ui/components/ui/<组件文件>` 具体路径复用，不导入 `app-ui` 或工作台业务状态。Tailwind 扫描本地 UI 与 `packages/ui/src`，生成共享组件需要的工具类。Bots Modal 保留自身遮罩与关闭/Portal 生命周期；多选 Check 保留原生复选框，组件库没有 Checkbox，不替换为 Switch。设置使用分类弹窗，聊天按固定私聊或群组 ID 保存草稿和阅读位置。动效使用 React View Transitions 与局部 CSS，兼容系统及 Bots 自身的减少动态效果设置；后台刷新不触发整页过渡。

默认数据保存在**运行服务的操作系统用户**的 `~/.pi-meme-bot/`。一个目录只允许一个服务进程写入，手工验收可通过 `createBotService({dataDirectory})` 注入隔离目录。备份时先停止服务，再复制整个目录，包含凭据、数据库及附件。

模型配置采用 service 级连接与凭据、模型引用和聚合 revision。v1 数据升级至 v2 时为每个旧模型保留独立服务和绑定，旧对话模型在原位重新验证。`Bot.modelId:null` 跟随默认，Web 默认助理与 QQ 默认角色分别配置。当前任务使用冻结的有效模型，后续调用继续检查凭据撤销。

正常聊天使用既有 messages 提交入口，忙时排队，补充必须绑定 `targetTaskId`。问题、授权与配置草稿通过新增的 `/api/v1/tasks/:id/responses` 回应，模型验证使用新增的 `/api/v1/settings/models/check`。同一 SSE `/api/v1/events` 同时提供资源变化与真实流式草稿。停止或失败保留实际部分正文，重连核对原发送并保留后来编辑的草稿。

历史上下文按 token 预算保留消息来源、近期图片与同模型摘要，较早附件由受控读取工具取得。输入框支持图片粘贴、拖拽、预览和移除，逐消息支持记忆保存、编辑及撤销。定时入口带入当前会话、Bot、设备时区和 Web 通知，确认只授权该条规则。

`POST /api/v1/bots/:id/conversation` 获取或打开固定私聊，并发调用复用同一 ID；固定 direct 禁止独立归档、删除或更换 Bot。升级时旧私聊历史与计划引用保留，不自动合并进固定消息流。完整部署、环境变量、数据恢复、API 契约和能力限制见 [Bots 文档](../../docs/bots.md)。入口源码为 [server/main.ts](src/server/main.ts)，业务类型见 [shared/types.ts](src/shared/types.ts)。

`/images/generations` 与旧模型配置写法保留兼容，迁移目标分别为 `/generations` 和带聚合 revision 的 `services`/`models`，移除目标为 Bots API v2。外部调用方迁移情况仍待维护者确认。

采用的 `pi-durable`、`pi-ai`、`pi-schema` 和 `chord` 锁定为 `1.5.0`，升级前应独立备份并核对恢复行为。独立 Hacker 已在 `pnpm start:bot` 的本机环境观察到真实文字对话、Host 连通、项目授权和委派完成。连续看图、流式恢复、摘要、QQ、生图账单及多台远程 Host 仍待对应环境验收。具体 Web/API 行为与边界记录见 [Bots 文档](../../docs/bots.md#本轮换手验收)。
