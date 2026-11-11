# Bots

独立的个人助理服务与 Web，支持角色 Bot、私聊、群聊、协作、定时任务、资料、Pi meme 项目工作和 QQ 官方机器人私聊。连通模型后，用户通过对话管理 Bot 及全部应用配置。

需要 Node.js **24.14.0 或更高版本**、pnpm **10.29.1**。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build:bot
pnpm serve:bot
```

打开 `http://127.0.0.1:4310`，首次设置访问密码、填写对话模型，点击“连接并开机”进入默认助理私聊。该按钮保存候选配置，实际检查模型的工具调用往返，再激活默认模型。检查会调用供应商并可能计费，失败后可在原位调整配置。预置服务填写模型 ID 与密钥，自定义兼容服务补充 URL。

Bot 可直接管理角色、模型与模型服务、Pi meme、QQ、主题、减少动态效果、时区、联网、记忆、群组、定时任务、登录密码和 API 令牌。删除、停用、撤销等重要操作通过对话确认。Pi meme 连接只填 URL 和密钥，保存后自动检查，全部 Bot 立即获得所有项目及以后新增项目的访问能力。QQ 填 AppID 和 AppSecret 后自动连接，需要本人绑定时 Bot 提供绑定码。

创建 Bot 只需名称和职责，模型默认继承，创建时建立 QQ 与 Web 共用的主对话。两端共享消息、上下文、附件和任务状态，回复默认发送到任务发起渠道。主界面采用左侧 Bot/群组列表和右侧聊天，空私聊提供连接 Pi meme、接入 QQ、调整外观的对话入口。左下头像菜单中的设置支持手动查看和编辑。

开发时，在两个终端分别运行：

```bash
pnpm start:bot
```

```bash
pnpm dev:bot
```

Web 开发入口是 `http://127.0.0.1:4311`。`start:bot` 启动源码服务；`dev:bot` 启动 Vite 并代理 `/api`，两者均不启动工作台 Host。4310 提供上一次 `build:bot` 生成的页面；修改 UI 时用 4311 热更新，或重新构建后在 4310 刷新。

Web UI 在 [src/ui](src/ui) 维护 DS-Bot 布局、主题 token、业务状态与动效，Select、Button、Input、Textarea、Tooltip、DropdownMenu 按 `@pi-meme/ui/components/ui/<组件文件>` 具体路径复用，不导入 `app-ui` 或工作台业务状态。Tailwind 扫描本地 UI 与 `packages/ui/src`，生成共享组件需要的工具类。Bots Modal 保留自身遮罩与关闭/Portal 生命周期；多选 Check 保留原生复选框，组件库没有 Checkbox，不替换为 Switch。设置使用分类弹窗，聊天按固定私聊或群组 ID 保存草稿和阅读位置。动效使用 React View Transitions 与局部 CSS，兼容系统及 Bots 自身的减少动态效果设置；后台刷新不触发整页过渡。

默认数据保存在**运行服务的操作系统用户**的 `~/.pi-meme-bot/`，可通过 `PI_BOT_DATA_DIR` 指定新目录。当前数据模型为 v4，启动要求同版本数据，旧版本会得到明确的版本提示。一个目录只允许一个服务进程写入，手工验收可通过 `createBotService({dataDirectory})` 注入隔离目录。备份时先停止服务，再复制整个目录，包含凭据、数据库及附件。

模型配置采用 service 级连接与凭据、模型引用和聚合 revision。`Bot.modelId:null` 跟随默认，Web 默认助理与 QQ 默认角色均可由 Bot 设置。当前任务使用冻结的有效模型，角色和模型修改在后续任务生效，显式撤销密钥会阻断后续模型调用。

正常聊天使用 messages 提交入口，QQ 与 Web 共用队列，补充必须绑定 `targetTaskId`。QQ 的 `/补充 <内容>` 指向当前运行轮，并沿用该轮的回复渠道。问题与重要操作确认通过 `/api/v1/tasks/:id/responses` 回应，QQ 可直接回复答案、选项序号或“确认”“取消”。QQ 投递绑定发起时的用户身份与绑定代次。配置工具复用 HTTP 路由的校验、持久化和幂等回执。SSE `/api/v1/events` 同时提供资源变化与真实流式草稿，Bot 调整外观后已打开页面自动同步。

历史上下文按 token 预算保留消息来源、近期图片与同模型摘要，较早附件由受控读取工具取得。输入框支持图片粘贴、拖拽、预览和移除，逐消息支持记忆保存、编辑及撤销。Bot 可直接保存记忆和安排定时工作，默认带入当前会话、Bot 与应用时区。

`Bot.conversationId` 指向主对话，`POST /api/v1/bots/:id/conversation` 获取该记录，并发调用复用同一 ID。主对话通过 Bot 管理，群聊通过 `/conversations` 创建。完整部署、环境变量、数据恢复、API 契约和能力限制见 [Bots 文档](../../docs/bots.md)。入口源码为 [server/main.ts](src/server/main.ts)，业务类型见 [shared/types.ts](src/shared/types.ts)。

模型配置统一使用带聚合 revision 的 `services` 和 `models`，服务密钥在 `services` 中写入。图片生成入口为 `/generations`。

采用的 `pi-durable`、`pi-ai`、`pi-schema` 和 `chord` 锁定为 `1.5.0`，升级前应独立备份并核对恢复行为。验收使用 `pnpm start:bot` 的本机环境，由独立 Hacker 记录真实对话、配置结果与外部服务回执。当前改造的验收范围与早期版本记录分别列在 [Bots 文档](../../docs/bots.md#对话配置改造验收)。
