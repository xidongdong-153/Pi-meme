# UI 元数据

本文件改编自 OpenAI Codex skill-creator 的 UI 元数据说明，用于需要同时兼容 Codex 的技能。普通 Pi 技能只需 `SKILL.md`。

`agents/openai.yaml` 是 Codex 专有的展示配置。pi-meme 的技能发现和权限判断不依赖该文件。保持 `SKILL.md` 中的名称、描述和 Pi 调用配置完整。

```yaml
interface:
  display_name: 'Report Editor'
  short_description: '按现有模板更新报告中的正文、表格和结论'
  default_prompt: '使用 $report-editor 更新这份报告。'
```

- `display_name`：界面显示名称。
- `short_description`：列表中的简短说明。
- `icon_small`、`icon_large`：相对于技能目录的图标路径；添加时确认文件存在。
- `brand_color`：十六进制颜色值。
- `default_prompt`：简短的调用示例，必须含 `$skill-name`。

更新已有文件时，只修改当前要求的字段，保留无关的 `policy` 和 `dependencies`。不要通过整体重生成丢失原有配置。

Codex 的 `policy.allow_implicit_invocation` 控制 Codex 自动选择；Pi 使用 `SKILL.md` 的 `disable-model-invocation`。两者是不同产品配置。兼容两种产品时，按用户要求分别维护。
