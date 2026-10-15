---
name: plugin-creator
description: 创建或更新 pi-meme App 插件。用于在当前项目编写 package.json、Agent、界面或后台入口，以及打包安装到应用的个人插件列表。
metadata:
  display-name: Plugin Creator
  short-description: 创建或更新 App 插件
---

# Plugin Creator

在当前工作区创建或更新 pi-meme App 插件源码，使用户安装后能在应用里使用。

从设置「插件 → 添加 → 创建插件」调用时，输入通常是「帮我创建一个插件」。这时先确认插件要做什么，以及需要 Agent、右侧面板、后台服务、主题、包内技能中的哪些能力。用户已经说明目标时直接写文件，不为了补齐模板而追问。

## 个人和系统

- 本技能创建的是个人插件。安装后出现在设置「插件 → 个人」，可以启用、停用、更新和卸载。
- 系统插件是应用自带的变更、文件和终端。它们始终启用，不能停用、卸载、覆盖或用新插件替换。
- 插件不能替换左侧导航或中央聊天。工具面板的 `location` 只能是 `right`。
- 不要把插件写成 Host 内置模块，也不要修改应用仓库里的内置装配。

## 输出位置

- 用户指定目录时使用该目录。未指定时，在当前工作区创建 `plugins/<package-name>/`。目标目录必须尚不存在。
- 包名是合法 npm 名：可选 `@scope/`，其余以小写字母或数字开头，只含小写字母、数字、`.`、`_`、`-`。版本使用语义版本号，新建用 `0.1.0`。
- 写到工作区只是源码，不会自动出现在插件列表。交付时说明还需要构建并安装。
- 当前工作区存在 `packages/plugin-devkit/src/cli.ts` 时，用该 DevKit 创建、构建、校验和打包。否则按下面的结构直接写源码。两种情况都不执行 `pnpm install` 或安装脚本。
- 会话处于规划模式、只读权限或路径不允许写入时，只给出文件方案，不切换权限、不写入、不绕过 Host 限制。

DevKit 在 pi-meme 仓库根目录执行：

```bash
pnpm exec tsx packages/plugin-devkit/src/cli.ts create <新目录绝对路径> <package-name>
pnpm exec tsx packages/plugin-devkit/src/cli.ts build <插件目录>
pnpm exec tsx packages/plugin-devkit/src/cli.ts validate <插件目录>
pnpm exec tsx packages/plugin-devkit/src/cli.ts pack <插件目录> <插件目录>.pim
```

`create` 生成的是带示例时钟工具的骨架。用户要的不是示例时，改掉示例入口，只保留本次需要的文件。移动目录后，DevKit 写进 `package.json` 的 SDK `link:` 会失效，需要改路径，不要假设依赖已经装好。

## 包格式

`package.json` 使用 `"type": "module"`，并声明 `piMeme.sdkVersion: 2`。只声明实际使用的入口：

| 能力                   | 源码                                          | manifest 入口                                              |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 后台服务               | `src/server/entry.ts` 导出 `create(context)`  | `dist/server/chord-facets.json`                            |
| Agent 工具、命令和钩子 | `src/agent/entry.ts` 导出 `activate(context)` | `dist/agent/entry.js`                                      |
| 右侧面板和界面贡献     | `src/ui/entry.tsx` 导出 `activate(context)`   | `dist/ui/entry.js`                                         |
| 主题、包内技能、图片   | 包内相对路径                                  | `resources.skills`、`resources.themes`、`resources.assets` |

至少要有一个代码入口，或一项非空 `resources`。路径必须在包内，不能是 `..`、绝对路径或通配符。

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "description": "插件做什么。",
  "piMeme": {
    "sdkVersion": 2,
    "display": { "name": "插件显示名" },
    "agent": "dist/agent/entry.js"
  }
}
```

- Agent 工具返回 `{ text, data? }`，`data` 必须可序列化为 JSON。安装或启用不会把插件加入当前聊天，也不会把任务改成完全权限。外部 Agent 只在完全权限的普通任务中加载。
- UI 使用宿主提供的 React，不把 Node 产物打进浏览器。面板注册时 `location` 为 `right`。
- 包内技能目录包含 `SKILL.md`，并列入 `resources.skills`。安装后它们出现在技能页，标记为来自插件，属于个人技能，不是系统技能。
- 纯主题插件可以只有 `package.json`、主题 JSON 和图片。主题不执行 JavaScript 或任意 CSS。

更新已有插件时先读取现有 manifest 和入口，只改当前任务需要的部分，保留包名。不要为了统一样式重写整个插件。

## 交付

说明源码目录、声明了哪些入口，以及验证结果。没有构建时说明尚未生成 `dist`。没有打包或安装时说明插件还不会出现在「插件 → 个人」；用户需要在设置里上传 `.pim`，或由已连接的 Host 加载构建目录。正在使用的旧版本会保留到任务结束。
