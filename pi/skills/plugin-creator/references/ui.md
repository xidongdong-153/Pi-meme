# UI 能力

UI 入口导出 `activate(context)`，读取本技能 `dist/toolchain/node_modules/@pi-meme/plugin-sdk/src/ui.d.ts`，再按本次能力读取同目录的 `composer.d.ts`、`reactive.d.ts`、`message-actions.d.ts` 或 `navigation.d.ts`。使用宿主 React，不把 React 本体打入插件。

- 使用输入框：申请对应 `composer.read/write/attachments/submit/before-send`。先用 `composer.current()` 取得 view，再使用它的 ref/revision；离开聊天或目标改变后重新取得。不要维护第二份可写草稿、操作隐藏输入框、绕过 CAS/IME/上传/配置保存检查，或用 DOM 模拟发送。
- 发送前处理：局部 hook ID 列入 `permissions.beforeSend`，默认不执行，交给用户逐项开启。只能 pass、replace 或 block 候选输入；附件仅使用已有 ready 引用，不在 hook 内上传。异常与超时必须阻止发送，不吞错放行。
- 读取消息：申请 `reactive.read/messages.read`，使用 metadata/select/body 或 messages.page/getMessage。MessageRef 用 Pi 原生 entryId，不根据时间戳或数组下标构造；不能导出隐藏 thinking、展开技能全文、base64 或凭据。
- 消息动作：使用 `messageActions.register`，申请 `messages.actions` 与 `messages.read`，声明 roles 和 source。宿主控制菜单、busy 与确认，不注册旧 `message-actions` contribution。自定义正文 renderer 仍只能匹配本插件 ownerId/generation。
- 中央业务页：使用 `pages.register` 和每插件一个 `navigation.register`，申请 `navigation.pages`。scope 为 app/project/session，菜单和默认页只引用本插件页面。页面使用捕获 target、signal、page.params/setParams/setUnsavedChanges；不改变后台聊天选择，不跨 Host 导航，不把秘密写入 params。
- 未保存表单用 `setUnsavedChanges(true)`，保存后设 false。租约过期后保留可见内容但停止保存，不向新代 Server 重放旧表单。

页面与面板最小模板位于本技能 `assets/templates/`。UI 调用 Server 必须配同代可信 Server，操作 audience 包含 ui；受限 Server 不能用作 UI 的后台。注册返回的释放函数需要在插件释放时执行，样式只作用于自己的根节点。
