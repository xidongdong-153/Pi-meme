---
name: plugin-creator
description: 创建或更新 pi-meme App SDK 4 插件，按需生成受限 Agent、Server、声明式 JSON UI、主题和包内技能，检查并打包可安装的 .pim。
metadata:
  display-name: Plugin Creator
  short-description: 创建、迁移并打包 App 插件
---

# Plugin Creator

在当前工作区创建或更新个人 App 插件，默认交付源码与可导入的 `.pim`。随附工具和 SDK 4 不依赖公开 npm SDK 包或 pi-meme 源码仓库。不要把内置模块版本 3 当作外部插件 SDK 版本。

## 目标与迁移

用户已有明确目标时直接推进；只有缺少功能目标或使用入口时才询问。按最小能力选择受限 Agent、受限 Server、声明式页面/面板、主题和技能，不默认生成全部方向。

- 源码默认在当前工作区 `plugins/<不含 scope 的包名>/`；用户指定位置时保留。新目录必须不存在，包名保留完整 scope，新版本默认 `0.1.0`。
- 更新先读取现有 manifest、源码、构建命令与工具版本，不重新初始化或覆盖用户文件。保留包名和用户数据。
- SDK 4 仅支持 `agent.restricted`、`server.restricted` 和 `.json` UI。旧 SDK 2/3 的 trusted Node、React/JS UI、同进程服务不能靠改版本字段迁移。按新契约重建并重新授权；不静默删除旧源码或用户资产。
- SDK 3 纯资源包无 agent/server/ui 时可由解析器升级；资源路径限制不变。旧代码包不运行。
- 只读或 Plan 模式只给文件方案，不创建、构建、打包，不切换权限。普通 Full 任务也不能绕过 Host 私有根或缺失的沙箱能力。

| 当前任务                       | 读取资料                                                 |
| ------------------------------ | -------------------------------------------------------- |
| manifest、入口、权限或旧版迁移 | [references/manifest.md](references/manifest.md)         |
| Agent 工具或 Server 操作       | [references/agent-server.md](references/agent-server.md) |
| 声明式页面、面板与动作         | [references/ui.md](references/ui.md)                     |
| 主题、素材或包内技能           | [references/resources.md](references/resources.md)       |

具体接口读取本技能 `dist/toolchain/node_modules/@pi-meme/plugin-sdk/src/` 对应 `.d.ts`；声明式 UI 读取 `declarative-ui.d.ts`，受限入口读取 `restricted.d.ts`。旧 SDK 类型文件仍存在不代表 SDK 4 外部入口允许调用。`agents/openai.yaml` 不参与 Pi 权限。

## 初始化与恢复工具

命令中的 `<技能目录>` 替换为当前 SKILL.md 的绝对所在目录。工具要求 Node.js >=22.19.0；先检查 `command -v node` 与 Host 明确提供的固定 Node 路径，不自行下载或遍历用户目录。

```bash
node <技能目录>/scripts/plugin.mjs doctor
node <技能目录>/scripts/plugin.mjs create <新目录绝对路径> <package-name> --agent restricted --server restricted --display-name 插件名称
```

`doctor` 检查 SDK、平台、依赖与 esbuild；失败时报告步骤并停止，不改用无沙箱 runner。`create` 选项：

- `--agent none|restricted`
- `--server none|restricted`
- `--ui none|panel|page`
- `--resources skills,themes,assets`
- `--display-name <显示名称>`

指定任一能力选项后，未选能力不生成。无能力选项的默认示例为受限 Agent、受限 Server 与 JSON 面板；实际任务明确传需要的选项。纯页面使用 `--ui page`，纯主题使用 `--resources themes`，不创建空插件。

生成工程包含源码、manifest、命令和 `.pi-meme-devkit/`；不安装依赖或执行安装脚本。UI JSON 由当前 generator 生成，不读取 React 模板。Agent/Server、技能和主题模板在 `assets/templates/`，只用于起点，交付前替换示例业务。

已有工程不要再次 create。工具缺失时运行 `node <技能目录>/scripts/plugin.mjs prepare <插件目录>`，只恢复工具；旧 manifest 不兼容时先迁移业务契约，不能用 prepare 绕过。工程工具路径应随源码一起保留，生成的工具产物在 `.pi-meme-devkit/dist/`，不进入业务包。

## 实现与检查

Agent 工具返回 `{ text, data? }`，data 必须 JSON 可序列化。Server 明确 schema、audience、effect 与 capabilities。UI action 只能调用同插件同代次受限 Server；不能导入包内 JS、HTML、CSS、宿主 React 或完整 HostApi。Plan/read-only 是硬顶，一次批准不提升权限。

不把凭据写入源码、manifest、UI input、日志或技能。HTTPS 只走获准 broker，credentialRef 不引用 Host、模型或 MCP 密钥。平台缺项返回 sandbox-unavailable 时停止，不换 runner 或降级到无沙箱。

在插件目录执行：

```bash
node .pi-meme-devkit/cli.mjs check .
node .pi-meme-devkit/cli.mjs build .
node .pi-meme-devkit/cli.mjs validate .
node .pi-meme-devkit/cli.mjs pack . ../my-plugin.pim
```

每步通过后才执行下一步。check 校验源码、类型、manifest 与 JSON UI；build 生成受限 JS 和 UI JSON，validate 校验安装产物，pack 再校验后输出 `.pim`。失败保留源码并报告，不打包旧 dist，不因缺依赖擅改工程或安装依赖。检查通过不表示真实受限运行已验收。

## 交付

交付源码位置、`.pim` 路径、声明能力、实际运行的检查和未验路径。真实功能必须由换手者沿应用用户路径观察，写清 oracle 和 Hacker；不能把构建、类型检查或模板输出来代替功能证据。未运行真实路径就标未验，不声称 Windows 或全链路通过。

用户在设置「插件 → 添加」上传 `.pim`。安装、项目启停、会话选择和能力授权仍分别完成，不自行安装或替用户授权。更新与撤权取消旧调用不保证外部效果回滚；结果不明保留 outcome-unknown，不自动重放写操作。技能源码修改未经过应用资源刷新时，说明尚未安装到当前系统技能快照。
