# 声明式 UI

读取随附 `dist/toolchain/node_modules/@pi-meme/plugin-sdk/src/declarative-ui.d.ts`。SDK 4 UI 是 JSON，源码 `src/ui/entry.json`，构建产物 `dist/ui/entry.json`；没有 activate/render 函数。Host 渲染固定控件，不导入插件 JS、React、HTML 或 CSS。

```json
{
  "version": 1,
  "pages": [
    {
      "id": "main",
      "title": "状态",
      "scope": "app",
      "blocks": [
        { "kind": "text", "text": "当前状态" },
        { "kind": "action", "title": "刷新", "operation": "status", "input": {} }
      ]
    }
  ]
}
```

- 根字段只接受 version/pages/panels；scope 为 app/project/session。
- pages/panels 每类最多 32 项，id 全包唯一、以字母起始，只含字母数字、下划线、点或横线，最长 80；title 非空、最长 160。
- 每个 surface 最多 128 blocks，全包最多 512；序列化 JSON 长度最多 128 × 1024 字符。text 最长 16,000 字符。
- 当前 block 只支持 text/action。action 的 operation 为同插件局部操作名，不能加插件前缀，input 为 JSON。
- 页面需申请 navigation.pages。action 路由到同代受限 Server，操作 audience 包含 ui；Host 继续检查实际目标、schema、effect、capabilities、grant 与取消信号。

UI JSON 由 generator 直接生成，不需要模板里的 React 文件。旧 composer hook、before-send JS、message renderer、messageActions、pages.register/navigation.register 不是 SDK 4 外部能力。随附旧类型文件不能用来绕过 manifest 和加载器。

迁移现有 React 插件时保留用户源码，逐项转成声明与受限操作；当前控件无法表达的功能明确报告能力缺口，不回退同源 JS，也不擅自删除旧资产。页面参数和 input 不放凭据。重放或取消后结果不明的写操作不自动重试。
