---
name: plugin-creator
description: 创建或更新 pi-meme App 插件，按需生成 Agent、Server、UI、主题和包内技能，检查源码与构建产物并打包可安装的 .pim。
metadata:
  display-name: Plugin Creator
  short-description: 创建、检查并打包 App 插件
---

# Plugin Creator

在当前工作区创建或更新个人 App 插件，默认交付源码与可导入的 `.pim`。工具随技能分发，不依赖 pi-meme 源码仓库或公开 npm SDK 包。

## 1. 确认目标与能力

从设置「插件 → 添加 → 创建插件」进入时，用户通常只说“帮我创建一个插件”。先问插件要完成什么，以及用户如何使用它。已有明确目标时直接推进，只追问会影响实现的信息。

根据目标选择受限或可信 Agent、Server、UI 面板或业务页、主题、包内技能。只声明实际需要的入口和权限，不默认生成全部示例。最小权限能完成任务时使用受限入口；UI 和可信入口需要独立授权。

- 默认源码位置是当前工作区 `plugins/<不含 scope 的包名>/`；用户指定目录时保留指定位置。新目录必须不存在，包名保留完整 scope。新版本默认 `0.1.0`。
- 更新时读取现有 manifest、入口、构建命令和工具版本，不重新初始化，不覆盖用户文件；保留包名。SDK 2 按 SDK 3 契约重建，不能只修改版本字段。
- 插件不能替换系统插件、内置导航或聊天，也不能改成 Host 内置模块。只读或规划模式只给出文件方案，不运行创建、构建或打包命令，不切换权限。

按需读取资料：

| 当前任务                        | 读取资料                                                 |
| ------------------------------- | -------------------------------------------------------- |
| 创建或调整 manifest、入口、权限 | [references/manifest.md](references/manifest.md)         |
| Agent 工具或 Server 操作        | [references/agent-server.md](references/agent-server.md) |
| 面板、页面、输入框、消息或导航  | [references/ui.md](references/ui.md)                     |
| 主题、图片或包内技能            | [references/resources.md](references/resources.md)       |

具体接口读取本技能 `dist/toolchain/node_modules/@pi-meme/plugin-sdk/src/` 下对应的 `.d.ts`，它们与随附构建工具版本一致。不要猜接口。`agents/openai.yaml` 不参与 Pi 的权限或调用配置。

## 2. 检查环境并初始化

以下命令中的 `<技能目录>` 替换为本 `SKILL.md` 所在目录的绝对路径。脚本使用 Node.js >=22.19.0。先检查 `command -v node`；缺失时检查 Host 已提供的 Node 路径，不自行下载或安装。仍不可用时报告缺少的运行条件并停止。

```bash
node <技能目录>/scripts/plugin.mjs doctor
node <技能目录>/scripts/plugin.mjs create <新目录绝对路径> <package-name> --agent restricted --server restricted --display-name 插件名称
```

`doctor` 检查 SDK、平台、依赖文件和 esbuild 可执行性。失败时报告当前步骤和原因，不改用手写构建器或无沙箱运行。

`create` 支持以下能力选项：

- `--agent none|restricted|trusted|both`
- `--server none|restricted|trusted|both`
- `--ui none|panel|page`
- `--resources skills,themes,assets`，按需选择逗号分隔的资源类型。
- `--display-name <显示名称>`

提供任一能力选项后，未选能力默认不生成。完全不传能力选项时保留 DevKit 的示例时钟兼容模板；实际任务应显式传所需能力。例如纯页面使用 `--ui page`，纯主题使用 `--resources themes`。不创建空插件。

初始化生成入口、manifest、TypeScript 配置、命令和 `.pi-meme-devkit/` 本地工具。工具与 SDK 使用工程内路径，移动工程时一起保留；不执行依赖安装或安装脚本。模板里的时间工具、面板和说明技能只是可运行起点，按真实需求替换后再交付。

已有插件不运行 `create`。使用它现有的构建流程。由本技能生成的工程把开发工具产物放在 `.pi-meme-devkit/dist/`，不作为业务源码提交；重新检出或工具缺失时，运行 `node <技能目录>/scripts/plugin.mjs prepare <插件目录>` 恢复工具，保留已有源码、配置和命令入口。其他工程可使用本技能命令 `check/build/validate/pack <插件目录>`，配置中的 SDK 类型路径指向本技能对应目录。若缺失依赖或构建约定不兼容，停在失败点说明原因，不擅自重写工程配置或安装依赖。

## 3. 实现并检查源码

先实现真实功能，再运行工程内的检查命令；命令均在插件目录执行：

```bash
node .pi-meme-devkit/cli.mjs check .
```

`check` 检查 manifest、内置身份冲突、资源路径、包内技能格式、源入口和必要导出，运行 TypeScript 检查，并检查 UI 是否可作为浏览器代码构建。纯资源插件检查资源，不要求创建 TS 源码。

- 使用当前 SDK 类型，工具返回 `{ text, data? }`，只传 JSON 可序列化数据。
- 调用 Server 明确 audience、effect 和 capabilities。Plan 只使用获准的受限只读入口，不回退可信入口。
- 不把凭据写入源码、manifest、页面参数、日志或包内技能。
- 用户请求涉及外部服务、文件写入或界面交互时，用临时数据和可释放的 fixture 验证关键行为；不要以模板能构建代替功能验证。

只修本次产生的问题。遇到无法修复的依赖、权限或接口缺失时，保留源码，说明具体阻塞和已完成结果，不继续宣称创建成功。

## 4. 构建、校验与打包

源码检查通过后依次执行：

```bash
node .pi-meme-devkit/cli.mjs build .
node .pi-meme-devkit/cli.mjs validate .
node .pi-meme-devkit/cli.mjs pack . ../my-plugin.pim
```

把输出名替换为本插件包名。`build` 生成 `dist`，可信 Server 使用 Chord 产物。`validate` 共用应用安装器的入口、资源、浏览器模块和 Chord 完整性检查。`pack` 再次校验后生成 `.pim`，仅包含安装器允许的产物和显式资源，不包含源码、开发工具或 `node_modules`。

每步失败都停止后续步骤，报告步骤、文件和原因。修复后重跑受影响步骤；修改源码后必须重新构建，不能直接打包旧 `dist`。校验不会证明业务行为正确，也不代表已经安装或启用。

## 5. 交付

说明源码目录、`.pim` 路径、实际声明的入口和权限、通过的检查，以及尚未运行的功能验证。默认由用户在设置「插件 → 添加」上传 `.pim`；写入工作区和打包不会自动进入个人插件列表。

安装、项目启停、会话选择、受限能力和可信 UI/Agent/Server 授权是不同步骤，按实际能力说明需要用户完成哪些操作。不自行安装插件，不替用户信任代码；旧版本任务继续持有原代次直到结束。
