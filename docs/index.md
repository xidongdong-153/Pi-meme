---
description: '项目文档总索引，按运行、开发和接口主题定位文档与源码'
status: implemented
paths: []
---

# 项目文档

pi-meme 的 Desktop 和 Web 共用 Node Host。应用入口在 `apps/`，基础包与内置能力在 `packages/`，独立分发的 App 插件源码在 `plugins/`。

下列“现状”表示已对照源码整理，不表示本次执行过对应构建或业务测试。验收记录只代表记录日期的环境和结果。

## 阅读入口

| 文档                                        | 解决什么问题                                         | 状态                   | 关联路径                                                                           |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| [快速开始](getting-started.md)              | 下载独立包、启动默认隔离的开发环境或部署 Server      | 现状                   | `apps/desktop`、`apps/server`、`apps/web`                                          |
| [开发与验证](development.md)                | 确定修改位置、质量检查、测试与打包命令               | 现状                   | `package.json`、`scripts/`、`tests/`                                               |
| [版本发布](releasing.md)                    | 构建三个原生平台包，验收并创建 GitHub 草稿           | 现状                   | `scripts/package-host.mts`、`scripts/release.mts`、`.github/workflows/release.yml` |
| [测试](testing.md)                          | 区分日常文件级验证、CI 与手动完整验收                | 现状                   | `tests/catalog.ts`、`scripts/test.mts`                                             |
| [架构](architecture.md)                     | 理解进程、Host 复用、组合根、包边界和内置模块        | 现状                   | `packages/host`、`packages/app-ui`、`packages/pi-*`                                |
| [会话与协作](sessions.md)                   | 查会话生命周期、消息编辑、活动服务、子代理与目标续跑 | 现状                   | `packages/pi-runtime`、`packages/subagents`、`packages/chat`                       |
| [配置与安全](configuration.md)              | 查配置文件、凭据、权限和沙箱边界                     | 现状                   | `packages/settings`、`packages/models`、`packages/mcp`                             |
| [数据目录与存储](storage.md)                | 查数据目录规范布局、就地升级、换根迁移与安全回收     | 现状                   | `packages/contracts/src/storage-paths.ts`、`packages/host/src/storage/**`          |
| [Remote](remote.md)                         | 部署 Host、配置 HTTPS、连接远程服务与排错            | 现状                   | `apps/server`、`packages/host/src/transport-*`                                     |
| [HostApi v2](host-api.md)                   | 使用稳定目标、幂等提交、回执和事件补读               | 现状；末节为待确认规划 | `packages/contracts/src/app-host.ts`、`packages/client`                            |
| [App 插件开发](plugins.md)                  | 构建 SDK 3 插件、登记业务页与面板、管理授权和更新    | 现状                   | `packages/plugin-*`、`plugins/theme-landscape`                                     |
| [技能与 App 资源](skills-and-extensions.md) | 导入、编辑技能，配置调用策略与资源快照               | 现状                   | `packages/resources`、`pi/skills`                                                  |
| [Linux 与 WSL](linux-wsl.md)                | 在 Linux/WSL2 运行 Host/Web，检查平台隔离            | 现状                   | `packages/sandbox-linux`、`.github/workflows/linux.yml`                            |
| [WSL 验收记录](wsl-validation.md)           | 查看 2026-10-13 的环境、结果与未执行项               | 历史记录               | 记录中的临时环境                                                                   |

## 按修改目标查源码

| 修改目标                     | 先读文档                                                       | 代码入口                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入框、消息、工具卡片       | [开发与验证](development.md)、[会话与协作](sessions.md)        | [聊天 UI](../packages/chat/src/ui/)、[App 组合](../packages/app-ui/src/app.tsx)                                                                                         |
| Host 路由、认证与远程代理    | [Remote](remote.md)、[HostApi v2](host-api.md)                 | [传输路由](../packages/host/src/transport-app.ts)、[远程服务](../packages/host/src/remote-services.ts)                                                                  |
| 模型、MCP、指令与主题        | [配置与安全](configuration.md)                                 | [模型存储](../packages/models/src/server/config-store.ts)、[MCP 存储](../packages/mcp/src/server/config-store.ts)、[设置存储](../packages/settings/src/server/store.ts) |
| 活动服务、子代理与会话恢复   | [会话与协作](sessions.md)                                      | [协调器](../packages/subagents/src/server/coordinator.ts)、[会话池](../packages/pi-runtime/src/session-pool.ts)                                                         |
| 技能、插件和 UI 扩展         | [技能与资源](skills-and-extensions.md)、[App 插件](plugins.md) | [资源存储](../packages/resources/src/server/resource-store.ts)、[插件管理器](../packages/plugin-runtime/src/manager.ts)                                                 |
| 平台窗口、preload 与分发     | [开发与验证](development.md)、[架构](architecture.md)          | [Electron main](../apps/desktop/src/main/main.ts)、[Forge 配置](../apps/desktop/forge.config.ts)                                                                        |
| 数据根、布局升级与换根迁移   | [数据目录与存储](storage.md)                                   | [存储模块](../packages/host/src/storage/)、[路径契约](../packages/contracts/src/storage-paths.ts)                                                                       |
| 内置图片、应用图标与文件图标 | [开发与验证](development.md)                                   | [packages/assets/files](../packages/assets/files/)、[FileIcon](../packages/ui/src/components/file-icon.tsx)                                                             |

文档中的源码链接相对于仓库；页面元数据的 `paths` 用于按源码检索。新增或调整实现时更新所属主题及本索引。长期规则以 [AGENTS.md](../AGENTS.md) 为准。
