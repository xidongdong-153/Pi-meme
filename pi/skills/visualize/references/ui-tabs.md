# UI Tab 预览

本例预览两个设置面板。Tab 的点击、方向键和 Home/End 导航由统一运行时提供；片段只把选中值与表单值绑定到 `piVisualize`，不重复实现键盘逻辑。标题、版本、设计参数和反馈由宿主提供。

保存参数：

```json
{
  "title": "偏好设置",
  "description": "切换资料和通知面板，编辑显示名称或通知开关；仅改变预览状态，不保存真实设置。",
  "initialState": { "tab": "profile", "displayName": "林知", "emailNotifications": true },
  "controls": [],
  "layout": "regular"
}
```

把下方片段作为 `html`。需要并列比较方案时再调整布局，不为两个 Tab 额外制作完整应用外壳。

```html
<div id="settings-tabs-demo">
  <div class="nav nav-pills" role="tablist" aria-label="设置分类">
    <button
      class="nav-link active"
      type="button"
      id="settings-tabs-demo-profile-tab"
      role="tab"
      aria-controls="settings-tabs-demo-profile"
      aria-selected="true"
      data-tab="profile"
    >
      资料
    </button>
    <button
      class="nav-link"
      type="button"
      id="settings-tabs-demo-notifications-tab"
      role="tab"
      aria-controls="settings-tabs-demo-notifications"
      aria-selected="false"
      tabindex="-1"
      data-tab="notifications"
    >
      通知
    </button>
  </div>
  <section
    id="settings-tabs-demo-profile"
    role="tabpanel"
    aria-labelledby="settings-tabs-demo-profile-tab"
    data-panel="profile"
  >
    <label class="settings-field" for="settings-tabs-demo-name">
      显示名称
      <input class="form-control" id="settings-tabs-demo-name" type="text" maxlength="40" value="林知" />
    </label>
  </section>
  <section
    id="settings-tabs-demo-notifications"
    role="tabpanel"
    aria-labelledby="settings-tabs-demo-notifications-tab"
    data-panel="notifications"
    hidden
  >
    <label class="viz-row" for="settings-tabs-demo-email">
      <input class="form-switch" id="settings-tabs-demo-email" type="checkbox" role="switch" checked />
      <span data-lucide="mail" aria-hidden="true"></span>
      邮件通知
    </label>
  </section>
  <p class="text-small" data-error role="alert" hidden></p>
</div>
<style>
  #settings-tabs-demo {
    display: grid;
    gap: var(--font-size-base);
    min-width: 0;
  }
  #settings-tabs-demo .settings-field {
    display: grid;
    gap: calc(var(--font-size-base) * 0.5);
    min-width: 0;
  }
</style>
<script>
  ;(() => {
    const root = document.getElementById('settings-tabs-demo')
    const api = window.piVisualize
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'))
    const panels = Array.from(root.querySelectorAll('[role="tabpanel"]'))
    const nameInput = root.querySelector('#settings-tabs-demo-name')
    const emailInput = root.querySelector('#settings-tabs-demo-email')
    const errorText = root.querySelector('[data-error]')

    function render(state) {
      tabs.forEach((tab) => {
        const selected = tab.dataset.tab === state.tab
        tab.setAttribute('aria-selected', String(selected))
        tab.classList.toggle('active', selected)
        tab.tabIndex = selected ? 0 : -1
      })
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.panel !== state.tab
      })
      if (nameInput.value !== state.displayName) nameInput.value = state.displayName
      emailInput.checked = state.emailNotifications
    }
    async function update(patch) {
      errorText.hidden = true
      try {
        await api.setState(patch)
      } catch (error) {
        errorText.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}`
        errorText.hidden = false
        render(api.getState())
      }
    }

    root.addEventListener('tabchange', (event) => {
      const value = event.detail.value
      if (tabs.some((tab) => tab.dataset.tab === value)) update({ tab: value })
    })
    nameInput.addEventListener('change', () => update({ displayName: nameInput.value }))
    emailInput.addEventListener('change', () => update({ emailNotifications: emailInput.checked }))
    render(api.getState())
    const stopState = api.subscribe(render)
    window.addEventListener('pagehide', stopState, { once: true })
  })()
</script>
```

`aria-controls` 和面板 ID 必须一一对应，同一片段里的 ID 保持唯一；`aria-labelledby` 指向对应 Tab。运行时在鼠标或键盘切换后发出冒泡 `tabchange`，`event.detail.value` 为 `data-tab` 值，片段用它提交状态，避免只监听 click 而漏掉键盘选择。订阅同步 `.active/aria-selected/tabIndex/hidden`，使宿主重置、恢复或其他预览的切换也能显示正确面板；不在订阅里调用 `click()` 或抢焦点。

这里的负 `tabindex` 仅用于标准 Tab 的游走焦点，不给普通布局或图形额外加焦点。面板使用原生 `hidden` 保留 DOM，不重建输入框。显示名称在 change 时提交；需要逐字同步的设计可改用 input，并保留输入长度限制和错误处理。产品输入用 `value`，文字用 `textContent`，不把用户输入拼入 `innerHTML`。
