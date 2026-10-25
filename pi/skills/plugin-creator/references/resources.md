# 主题、包内技能和资源

仅声明实际存在的包内相对路径，不使用绝对路径、`..`、通配符或软链接。`resources.skills`、`resources.themes`、`resources.assets` 中的目录会递归打包；不能把工程根或含凭据的目录声明为资源。

## 包内技能

每个技能目录包含 `SKILL.md`，并列入 `resources.skills`。名称、描述、脚本与引用文件需要完整；不要留下初始化占位符。安装后属于来自插件的个人技能，不是系统技能。

默认示例用于解释命令输出。用户请求其他任务时替换名称、触发描述和正文；把重复执行的逻辑放 scripts，把按需资料放 references。包内技能以自身 SKILL.md 为路径起点，不依赖创建插件时的工作目录。

## 结构化主题

纯主题插件只需 manifest、主题 JSON 和实际需要的图片，不生成 JS 入口。基础模板见 `assets/templates/theme.json`，字段类型见随附契约 `dist/toolchain/node_modules/@pi-meme/contracts/src/settings.d.ts`。

主题至少设置 id、name、appearance、colors 和 fonts。colors 使用 background、surface、elevated、text、muted、border、accent、accentText、success、error。fonts 设置 ui、code。主题不执行 JavaScript 或任意 CSS。

可选 tokens：spacing 为 0.5–2，radius 为 0–24，surfaceOpacity 为 0.4–1。背景包含 image、area、fit、position、opacity，可选 overlay、blur；area 为 app/workspace/sidebar，fit 为 cover/contain，position 为 center/top/bottom，opacity 为 0–1，blur 为 0–32。

背景图片必须包含在 resources.assets，支持 PNG、JPEG、WebP、AVIF，最大 8 MiB；主题 JSON 最大 256 KiB。不要把 SVG、远程 URL、脚本或 CSS 当作主题背景。显示图标与主题背景是不同资源，显示图标可以是 SVG。

DevKit 检查主题文件存在且为 JSON 对象。完整主题字段与背景加载效果还需应用验证，不能仅凭打包通过声称已完成视觉验收。

## 产物

.pim 是应用专用格式，不是 ZIP 或 npm tarball。必须使用随附 pack 命令。包的解压文件总大小上限为 32 MiB；源码工具包不进入插件分发包。打包前检查资源目录，避免把未使用文件或私人数据一并交付。
