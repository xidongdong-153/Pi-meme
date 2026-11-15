# UI 元数据与调用策略

`agents/openai.yaml` 是可选的兼容配置。pi-meme 读取其中三个字段，分别提供展示信息和默认调用方式；技能入口、名称和触发描述仍由 `SKILL.md` 提供。

```yaml
interface:
  display_name: 'Report Editor'
  short_description: '按现有模板更新报告中的正文、表格和结论'
policy:
  allow_implicit_invocation: false
```

| 字段                               | pi-meme 中的作用                         |
| ---------------------------------- | ---------------------------------------- |
| `interface.display_name`           | 非空字符串，作为技能显示名称             |
| `interface.short_description`      | 非空字符串，作为列表简短说明             |
| `policy.allow_implicit_invocation` | 布尔值；`false` 将默认调用方式设为仅手动 |

显示名称和简短说明分别优先使用上述 YAML 字段，其次使用 `SKILL.md` 的 `metadata.display-name/short-description`，最后使用 frontmatter 顶层的 `display-name/short-description`。这些显示字段不改变技能身份或替代 frontmatter 的 `name/description`。

调用方式按以下顺序决定：

1. 当前项目的显式调用策略。
2. Host 的显式调用策略。
3. 技能默认值：frontmatter 的 `disable-model-invocation: true` 或 YAML 的 `allow_implicit_invocation: false` 任一成立即为仅手动，否则允许自动发现。

因此 YAML 的 `true` 不会解除 frontmatter 的手动限制，也不会覆盖 Host 或项目的显式策略。YAML 解析失败或 `policy` 字段无效时显示诊断，技能默认仅手动；显示字段无效时显示诊断并回退其他有效展示元数据。资源启停独立生效，禁用技能不进入有效清单。

这些配置不授予文件、网络、工具或插件权限。自动发现和手动调用都在原任务权限与用户授权内执行；需要仅手动的技能仍保留显式选择入口。

pi-meme 不读取 `icon_small`、`icon_large`、`brand_color`、`default_prompt` 和 `dependencies` 等其他产品字段。已有技能需要兼容 Codex 时可保留这些配置：图标路径相对于技能目录，`default_prompt` 使用包含 `$skill-name` 的调用示例。更新已有文件只修改用户要求的字段，不整份重生成或丢弃无关配置。
