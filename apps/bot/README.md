# Bots

独立的个人助理服务与 Web，支持角色 Bot、私聊、群聊、协作、计划、资料、多 Host 委派和 QQ 官方机器人私聊。运行 Bots 不需要启动 Pi meme 工作台；模型、凭据和数据由 Bots 自己维护。

需要 Node.js **24.14.0 或更高版本**、pnpm **10.29.1**。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build:bot
pnpm serve:bot
```

打开 `http://127.0.0.1:4310`，首次设置访问密码，通过左下头像菜单打开设置弹窗并添加文本模型，再创建 Bot 或群组。主界面参考 DS-Bot，仅保留左侧 Bot/群组列表与右侧聊天；每个 Bot 自动关联唯一固定 Web 私聊，不提供独立会话管理。设置分类为外观、模型、联网、记忆、计划、资料、连接、访问凭据。图片模型单独配置，保存配置不会生成图片。

开发时，在两个终端分别运行：

```bash
pnpm start:bot
```

```bash
pnpm dev:bot
```

Web 开发入口是 `http://127.0.0.1:4311`。`start:bot` 启动源码服务；`dev:bot` 启动 Vite 并代理 `/api`，两者均不启动工作台 Host。4310 提供上一次 `build:bot` 生成的页面；修改 UI 时用 4311 热更新，或重新构建后在 4310 刷新。

Web UI 在 [src/ui](src/ui) 维护 DS-Bot 布局、主题 token、业务状态与动效，Select、Button、Input、Textarea、Tooltip、DropdownMenu 按 `@pi-meme/ui/components/ui/<组件文件>` 具体路径复用，不导入 `app-ui` 或工作台业务状态。Tailwind 扫描本地 UI 与 `packages/ui/src`，生成共享组件需要的工具类。Bots Modal 保留自身遮罩与关闭/Portal 生命周期；多选 Check 保留原生复选框，组件库没有 Checkbox，不替换为 Switch。设置使用分类弹窗，聊天按固定私聊或群组 ID 保存草稿和阅读位置。动效使用 React View Transitions 与局部 CSS，兼容系统及 Bots 自身的减少动态效果设置；后台刷新不触发整页过渡。

数据固定保存在**运行服务的操作系统用户**的 `~/.pi-meme-bot/`，与启动目录无关。一个目录只允许一个服务进程写入。备份时先停止服务，再复制整个目录，包含凭据、数据库及附件；不要只复制 SQLite 主文件。

`POST /api/v1/bots/:id/conversation` 获取或打开固定私聊，并发调用复用同一 ID；固定 direct 禁止独立归档、删除或更换 Bot。升级时旧私聊历史与计划引用保留，不自动合并进固定消息流。完整部署、环境变量、数据恢复、API 契约和能力限制见 [Bots 文档](../../docs/bots.md)。入口源码为 [server/main.ts](src/server/main.ts)，业务类型见 [shared/types.ts](src/shared/types.ts)。

当前代码已提供上述入口；真实模型聊天、QQ 账号、图片供应商、两台 Host 和远程服务器部署是否通过验收，需对应真实环境证据，不能根据页面存在或静态检查推断。采用的 `pi-durable`、`pi-ai`、`pi-schema` 和 `chord` 锁定为 `1.5.0`；`pi-durable` 属于实验性依赖，升级前应独立备份并核对恢复行为。
