---
description: '2026-10-13 WSL2 历史验收的环境、自动检查、隔离结果与未执行项'
status: implemented
paths: []
---

# WSL 验收记录：2026-10-13

本页保留 2026-10-13 的验收结果，测试数量、环境和未执行项均属于该次记录，不代表当前版本或本次文档整理重新验收。旧命令只供追溯，不作为当前开发检查清单；当前运行方法见 [Linux 与 WSL](linux-wsl.md)，日常文件级验证见 [测试](testing.md)。

该次环境可运行 Linux Host/Web，也可在默认工作区权限下执行真实 Worker 会话。

## 环境

| 项目       | 实际值                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| 系统       | Ubuntu 24.04.4 LTS，WSL2                                                  |
| 内核       | `6.18.54.1-microsoft-standard-WSL2`                                       |
| CPU        | x86_64                                                                    |
| 仓库       | `/home/xdd/code/Pi-meme`，Linux 文件系统                                  |
| Node       | 使用临时下载的 Linux Node.js 24.14.0 验收；本机原有版本为 24.21.0，未替换 |
| pnpm       | 10.29.1                                                                   |
| bubblewrap | Ubuntu 系统包 0.9.0，普通用户执行                                         |
| 浏览器     | Windows Microsoft Edge，隔离临时配置目录、headless 模式                   |

未修改 AppArmor、sysctl、监听地址、CORS 或来源白名单。安装 bubblewrap 前缺少系统依赖，用户通过 apt 安装后完成验收。没有运行 Electron 或调用真实模型；Host、凭据、模型服务与插件 fixture 都使用临时目录。

## 自动检查

依次执行 `pnpm type-check`、`pnpm lint`、`pnpm format`、`pnpm check-boundaries`、`pnpm test`、`pnpm build:web` 和 `pnpm test:server`，全部通过。通用测试 633 项，Server 产物测试 2 项，失败和跳过均为 0；包边界检查通过 476 个文件。

Server 产物测试同时保留完全权限的外部工具、MCP、持续子代理与计划案例，以及未配置 `defaultAccessMode` 的默认受限案例。默认案例实际执行 bash/write/edit，随后切换仅可查看并重启恢复，没有通过完全权限绕过沙箱。

## 隔离和持久化

| 项目         | 实际结果                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| 默认会话     | `workspace-write`，静态 Worker 可以执行工具                                                                |
| 工作区写入   | bash/write/edit 成功；临时目录可写                                                                         |
| 项目外写入   | bash/write/edit 被拒绝，原文件内容不变                                                                     |
| 只读         | 读取成功；bash/write/edit 修改业务文件被拒绝                                                               |
| 路径         | `..`、向外符号链接、整体授权禁止目录、工作区内 Host 数据均不能扩大写入范围                                 |
| 网络         | TCP 请求、UDP DNS 请求成功；DNS 配置文件可读                                                               |
| Unix socket  | 路径和 abstract socket 均返回 EPERM；seccomp 同时校验 i386、x32 和未知 ABI                                 |
| 缺失和失效   | 模拟缺少 bwrap、namespace 被拒绝和 seccomp 失败，Host 设置可读，默认任务不执行，权限保持 `workspace-write` |
| 子代理       | 继承工作区权限；bash 与 codemode 嵌套写入都不能越界                                                        |
| 规划模式     | 主任务和后代不执行 bash、写入、codemode、MCP 或外部工具；计划保存后不自动执行                              |
| 后代清理     | 取消、超时、stopAll 和父进程 SIGKILL 后，setsid 后代停止写入                                               |
| WSL 互操作   | Windows 盘上的 cmd.exe 和复制到工作区的 exe 都无法执行；互操作入口、宿主 proc 和额外 fd 不可用             |
| Windows 路径 | Windows 驱动器上的受限工作区明确拒绝；mountinfo 不把普通 /mnt 目录判为 Windows 盘                          |
| 恢复         | 重启后仅可查看权限、会话历史和计划保留；模型配置沿用 Host 文件                                             |
| 文件存储     | 凭据文件 0600；同一数据根的第二个写入锁被拒绝                                                              |

## Windows 浏览器

从 Windows Edge 直接访问 `http://127.0.0.1:31415/` 和 `http://127.0.0.1:5173/`，没有填写 WSL IP。

| 检查           | 31415 构建页面                  | 5173 开发页面                           |
| -------------- | ------------------------------- | --------------------------------------- |
| 页面渲染       | 成功                            | 成功                                    |
| 空令牌本机登录 | HTTP 200                        | HTTP 200                                |
| Cookie         | HttpOnly、SameSite=Strict       | HttpOnly、SameSite=Strict               |
| RPC            | 连接、设置、字体、插件查询成功  | 经 Vite 同源代理查询成功                |
| 权限快照       | supported=true，workspace-write | supported=true，workspace-write         |
| 事件 WebSocket | 收到 sessions-changed           | 经代理收到 sessions-changed             |
| 插件静态资源   | HTTP 200，正文正确              | 经同源代理 HTTP 200，正文正确           |
| 字体           | 返回空列表，页面正常            | 返回空列表，页面正常                    |
| 页面错误       | 未捕获 error 事件               | 未捕获 error 事件                       |
| 热更新         | 不适用                          | 收到一条 update，更新后的代码在页面执行 |

另起一个 Vite 验证端口冲突，明确返回 `Port 5173 is already in use` 和退出码 1，没有换端口。

HMR 检查临时修改 `apps/web/src/app.tsx`，完成后恢复原文。Edge 截图和原始检查结果保存在本次会话的 `/tmp/pi-meme-edge-31415.png`、`/tmp/pi-meme-edge-5173.png` 和 `/tmp/pi-meme-edge-results.json`；这些临时文件不属于分发产物。

## 该次未执行项

截至记录日期，Ubuntu 24.04 GitHub Actions 工作流尚未在原生 Ubuntu runner 执行。WSL 的结果不代替原生 Linux CI。

该次 WSL 机器无法运行 macOS 的 `package`、`test:package`、`test:desktop`，macOS 沙箱与应用回归仍需在 macOS 执行。

文档保留内联 Mermaid 图。Kroki 在线 SVG 导出返回 HTTP 403，未生成导出图像；未改换图形实现。
