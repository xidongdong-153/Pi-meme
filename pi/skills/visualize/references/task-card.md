# 任务卡片

本例展示四类宿主设计控件与产品按钮共用状态的写法；实际生成只保留有用控件，不为凑齐类型增加参数。保存参数使用 [协议示例](protocol.md) 中的 `initialState/controls`，并补充：

- `title`：`任务卡片`，由宿主显示。
- `description`：`点击完成会同步状态和进度；设计参数可调整状态、密度、进度和强调色。仅演示，不提交真实任务。`。
- `html`：下方片段作为字符串，正常进行一次 JSON 转义。
- `layout`：省略或 `regular`；无需 `libraries`。
- 新建省略 `reference`，修改使用真实版本引用。

```html
<div id="task-card-demo">
  <article class="card">
    <div class="viz-row">
      <strong>整理周报</strong>
      <span class="viz-badge" data-stage aria-live="polite"></span>
    </div>
    <p class="text-muted text-small" data-description>汇总本周进展，列出下周待办。</p>
    <div class="task-progress">
      <div class="viz-row">
        <span>进度</span>
        <output class="tabular-nums" data-progress-value></output>
      </div>
      <div class="task-track" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100">
        <div data-progress-fill></div>
      </div>
    </div>
    <div class="viz-row">
      <button class="btn btn-primary" type="button" data-complete>标记完成</button>
    </div>
  </article>
  <p class="text-small" data-error role="alert" hidden></p>
</div>
<style>
  #task-card-demo {
    display: grid;
    gap: var(--font-size-base);
    min-width: 0;
  }
  #task-card-demo [data-description],
  #task-card-demo .task-progress {
    margin-block: var(--font-size-base);
  }
  #task-card-demo .task-track {
    overflow: hidden;
    height: calc(var(--font-size-base) * 0.4);
    margin-block-start: calc(var(--font-size-base) * 0.5);
    background: var(--muted);
  }
  #task-card-demo [data-progress-fill] {
    height: 100%;
    background: var(--task-color);
  }
</style>
<script>
  ;(() => {
    const root = document.getElementById('task-card-demo')
    const api = window.piVisualize
    const button = root.querySelector('[data-complete]')
    const errorText = root.querySelector('[data-error]')
    let pending = false

    function render(state) {
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
    const stopState = api.subscribe(render)
    button.addEventListener('click', async () => {
      if (pending) return
      pending = true
      errorText.hidden = true
      render(api.getState())
      try {
        await api.setState({ stage: 'done', progress: 100 })
      } catch (error) {
        errorText.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}`
        errorText.hidden = false
      } finally {
        pending = false
        render(api.getState())
      }
    })
    window.addEventListener('pagehide', stopState, { once: true })
  })()
</script>
```

`compact` 控制产品说明的可见性，不覆盖 `.card` 的统一样式；`accent` 只影响进度标记，不用于文字底色。宿主参数可单独改变状态与进度，真实流程有组合约束时，产品操作要像本例一样一次提交所有关联键。

首次显示待处理和 40%，标记完成提交 `{ stage: 'done', progress: 100 }`；这描述示例意图，不是已执行的验收结论。失败演示应添加明确状态与内容，不通过真实网络制造故障。
