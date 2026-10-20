---
name: plugin-creator
description: 创建或更新 pi-meme App 插件。用于在当前项目编写 package.json、Agent、界面或后台入口，以及打包安装到应用的个人插件列表。
metadata:
  display-name: Plugin Creator
  short-description: 创建或更新 App 插件
---

# Plugin Creator

在当前工作区创建或更新 pi-meme App 插件源码，使用户安装后能在应用里使用。

从设置「插件 → 添加 → 创建插件」调用时，输入通常是「帮我创建一个插件」。这时先确认插件要做什么，以及需要受限 Agent、可信服务、输入框处理、消息动作、业务页面、右侧面板、主题、包内技能中的哪些能力。用户已经说明目标时直接写文件，不为了补齐模板而追问。

## 个人和系统

- 本技能创建的是个人插件。安装后出现在设置「插件 → 个人」，可以启用、停用、更新和卸载。
- 系统插件是应用自带的变更、文件和终端。它们始终启用，不能停用、卸载、覆盖或用新插件替换。
- 插件可注册自己的活动栏入口、次级菜单和中央业务页，不能替换内置首页、项目、插件管理、设置或聊天。工具面板的 `location` 仍只能是 `right`。
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

`package.json` 使用 `"type": "module"`，并声明 `piMeme.sdkVersion: 3`。不生成 SDK 2 代码，也不保留旧 `context.call`、`registerHandlers` 或 `message-actions` render 槽。只声明实际使用的入口：

| 能力                 | 源码                                               | manifest 入口                                              |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| 受限 Agent           | `src/agent/restricted.ts` 导出 `activate(context)` | `agent.restricted: dist/agent/restricted.js`               |
| 可信 Agent           | `src/agent/entry.ts` 导出 `activate(context)`      | `agent.trusted: dist/agent/entry.js`                       |
| 受限 Server          | `src/server/restricted.ts` 导出 `create(context)`  | `server.restricted: dist/server/restricted.js`             |
| 可信 Server          | `src/server/entry.ts` 导出 `create(context)`       | `server.trusted: dist/server/chord-facets.json`            |
| UI 页面、面板和贡献  | `src/ui/entry.tsx` 导出 `activate(context)`        | `ui: dist/ui/entry.js`                                     |
| 主题、包内技能、图片 | 包内相对路径                                       | `resources.skills`、`resources.themes`、`resources.assets` |

至少要有一个代码入口，或一项非空 `resources`。路径必须在包内，不能是 `..`、绝对路径或通配符。

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "description": "插件做什么。",
  "piMeme": {
    "sdkVersion": 3,
    "display": { "name": "插件显示名" },
    "agent": { "restricted": "dist/agent/restricted.js" },
    "permissions": {
      "restricted": {
        "maxAccess": "read-only",
        "capabilities": ["workspace.read"]
      }
    }
  }
}
```

- Agent 工具返回 `{ text, data? }`，`data` 必须可序列化为 JSON。安装、项目启停、会话选择和能力授权分别校验，不因安装提升权限。
- 优先生成真正需要的受限入口。Plan 仅加载获准的受限只读入口；可信 Agent 只在完全权限普通任务中、明确授权后加载。restricted-only 插件在完全权限任务中仍受原上限约束。
- 受限 JS/TS 产物在独立进程和 OS 沙箱执行，不能改成 Host 导入、VM 或 Worker 线程。平台不可用时报告 `sandbox-unavailable` 并停止，不退回无沙箱运行。不要把可执行文件或 Node 运行时打进插件。
- 受限工具和命令显式声明 effect 与 capabilities，不靠工具名前缀或 safe 标记放行。`permissions.restricted` 明确列出 maxAccess、capabilities、network 与 sharedData；缺省不授予能力。联网只走 `http.request` 和精确授权的 HTTPS origin/method，Plan 限 GET/HEAD。凭据只传插件专属 credentialRef，不复制 Host、模型或 MCP 的密钥。
- Server 用 `registerOperations` 登记局部 name、inputSchema、outputSchema、audience、effect、capabilities 和 execute；UI/Agent 统一通过 `context.server.call` 调用同插件同代次操作。受限入口不能回退可信 Server。
- UI 使用宿主 React，不把 Node 产物打进浏览器；可信 UI 在加载前单独授权，不把同源 React 宣传为恶意代码沙箱。面板 `location` 为 `right`。CSS 只作用自己的根并在释放时移除。
- 包内技能目录包含 `SKILL.md`，并列入 `resources.skills`。安装后它们出现在技能页，标记为来自插件，属于个人技能，不是系统技能。
- 纯主题插件可以只有 `package.json`、主题 JSON 和图片。主题不执行 JavaScript 或任意 CSS。

更新已有插件时先读取现有 manifest 和入口，只改当前任务需要的部分，保留包名。SDK 2 必须按新契约重建，不能只改 sdkVersion 后继续使用旧 API。不要为了统一样式重写整个插件。

## UI 能力选择

- 使用输入框：申请对应 `composer.read/write/attachments/submit/before-send`。先用 `composer.current()` 取得 view，再使用它的 ref/revision；离开聊天或目标改变后重新取得。不要维护第二份可写草稿、操作隐藏输入框、绕过 CAS/IME/上传/配置保存检查，或用 DOM 模拟发送。
- 发送前处理：局部 hook ID 列入 `permissions.beforeSend`，默认不执行，交给用户逐项开启。只能 pass、replace 或 block 候选输入；附件仅使用已有 ready 引用，不在 hook 内上传。异常与超时必须阻止发送，不吞错放行。
- 读取消息：申请 `reactive.read/messages.read`，使用 metadata/select/body 或 messages.page/getMessage。MessageRef 用 Pi 原生 entryId，不根据时间戳或数组下标构造；不能导出隐藏 thinking、展开技能全文、base64 或凭据。
- 消息动作：使用 `messageActions.register`，申请 `messages.actions` 与 `messages.read`，声明 roles 和 source。宿主控制菜单、busy 与确认，不注册旧 `message-actions` contribution。自定义正文 renderer 仍只能匹配本插件 ownerId/generation。
- 中央业务页：使用 `pages.register` 和每插件一个 `navigation.register`，申请 `navigation.pages`。scope 为 app/project/session，菜单和默认页只引用本插件页面。页面使用捕获 target、signal、page.params/setParams/setUnsavedChanges；不改变后台聊天选择，不跨 Host 导航，不把秘密写入 params。
- 未保存表单用 `setUnsavedChanges(true)`，保存后设 false。租约过期后保留可见内容但停止保存，不向新代 Server 重放旧表单。

仓库内开发时，先读本次实际使用的 SDK 文件：`packages/plugin-sdk/src/{manifest,permissions,restricted,rpc,composer,message-actions,reactive,navigation,ui}.ts`，示例与边界见 `docs/plugins.md`。仓库外无法取得相应契约时，不编造接口；说明缺少哪个文件或版本并停止该能力的实现。

## 交付

说明源码目录、声明了哪些入口，以及验证结果。没有构建时说明尚未生成 `dist`。没有打包或安装时说明插件还不会出现在「插件 → 个人」；用户需要在设置里上传 `.pim`，或由已连接的 Host 加载构建目录。正在使用的旧版本会保留到任务结束。
