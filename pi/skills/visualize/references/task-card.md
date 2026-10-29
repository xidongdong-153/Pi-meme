# 任务卡片示例

此例用于核对四类控件和双向状态绑定。实际生成时只保留与需求有关的控件。

保存参数使用 [协议示例](protocol.md) 中的 `initialState`、`controls`，并补充：

- `title`：`任务卡片交互预览`。
- `description`：`点击完成会同步状态和进度；设计控件可分别预览状态、密度、进度和强调色。不提交真实任务。`。
- `html`：下方完整片段作为字符串传给工具，正常进行 JSON 字符串转义，不把转义后的文本再次包进 HTML。
- 新建时省略 `reference`；修改已有草图时使用实际工具返回的引用。

```html
<section id="task-card-preview" aria-label="任务卡片预览">
  <div class="task-heading">
    <strong>整理周报</strong>
    <span data-stage aria-live="polite"></span>
  </div>
  <p data-description>汇总本周进展，列出下周待办。</p>
  <div class="task-progress-label">
    <span>进度</span>
    <output data-progress-value></output>
  </div>
  <div class="task-track" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100">
    <div data-progress-fill></div>
  </div>
  <div class="task-actions">
    <span>仅演示界面状态</span>
    <button type="button" data-complete>标记完成</button>
  </div>
  <p data-error role="alert" hidden></p>
</section>
<style>
  #task-card-preview {
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--card);
    color: var(--card-foreground);
  }
  #task-card-preview[data-compact='true'] {
    padding: 10px;
  }
  #task-card-preview .task-heading,
  #task-card-preview .task-progress-label,
  #task-card-preview .task-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  #task-card-preview p,
  #task-card-preview .task-actions > span {
    color: var(--muted-foreground);
  }
  #task-card-preview .task-progress-label {
    margin: 12px 0 6px;
    font-variant-numeric: tabular-nums;
  }
  #task-card-preview .task-track {
    overflow: hidden;
    height: 6px;
    border-radius: 3px;
    background: var(--muted);
  }
  #task-card-preview [data-progress-fill] {
    height: 100%;
    background: var(--task-color);
  }
  #task-card-preview .task-actions {
    margin-top: 14px;
  }
  #task-card-preview button {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--primary);
    color: var(--primary-foreground);
  }
  #task-card-preview button:disabled {
    opacity: 0.6;
  }
  #task-card-preview button:focus-visible {
    outline: 2px solid var(--foreground);
    outline-offset: 2px;
  }
  #task-card-preview [data-error] {
    color: var(--foreground);
  }
</style>
<script>
  ;(() => {
    const root = document.getElementById('task-card-preview')
    const api = window.piVisualize
    const button = root.querySelector('[data-complete]')
    const errorText = root.querySelector('[data-error]')
    let pending = false

    function render(state) {
      root.dataset.compact = String(state.compact)
      root.style.setProperty('--task-color', state.accent)
      root.querySelector('[data-stage]').textContent = state.stage === 'done' ? '已完成' : '待处理'
      root.querySelector('[data-description]').hidden = state.compact
      root.querySelector('[data-progress-value]').textContent = `${state.progress}%`
      root.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(state.progress))
      root.querySelector('[data-progress-fill]').style.width = `${state.progress}%`
      button.disabled = pending || state.stage === 'done'
      button.textContent = state.stage === 'done' ? '已完成' : pending ? '更新中…' : '标记完成'
    }

    render(api.getState())
    api.subscribe(render)
    button.addEventListener('click', async () => {
      if (pending) return
      pending = true
      errorText.hidden = true
      render(api.getState())
      try {
        await api.setState({ stage: 'done', progress: 100 })
      } catch (error) {
        errorText.textContent = `状态更新失败：${error instanceof Error ? error.message : String(error)}`
        errorText.hidden = false
      } finally {
        pending = false
        render(api.getState())
      }
    })
  })()
</script>
```

检查此例时，首次应显示“待处理”和 40%；点击“标记完成”后显示“已完成”和 100%，按钮禁用。宿主重置后恢复初始值；紧凑开关隐藏说明，强调色只改变进度条，滑块显示对应百分比。设计控件允许单独切换演示值；真实产品有组合约束时，在产品操作中一次提交所有关联键，并明确哪些状态允许组合。

如需模拟失败，应新增明确的状态选项和对应错误内容；不要通过真实网络请求制造错误。需要可编辑文本时，使用 `textContent` 或表单 `value` 更新，不把用户输入拼入 `innerHTML`。
