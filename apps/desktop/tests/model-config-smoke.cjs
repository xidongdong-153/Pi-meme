const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async (window, waitFor, outputDirectory) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const clickText = (text) =>
    evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.checkVisibility() && node.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('找不到按钮：' + ${JSON.stringify(text)}); button.click();
  })()`)
  const fill = async (label, value) => {
    const input = `[aria-label="${label}"]`
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(input)});
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
  }
  const capture = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(outputDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers.authorization, 'Bearer test-key')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'catalog-test' }, { id: 'another-model' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const originalSize = window.getSize()
  try {
    await evaluate('document.querySelector("button[aria-label=设置]").click()')
    await clickText('模型')
    const initiallyEmpty = await evaluate(
      'window.piMemeClient.getModelConfig().then(config => config.providers.length === 0)',
    )
    if (initiallyEmpty) {
      await waitFor(
        () => evaluate('window.piMemeClient.getModelConfig().then(config => config.providers.length === 0)'),
        '空白模型配置',
      )
    } else {
      await waitFor(() => evaluate('document.body.innerText.includes("本地验收接口")'), '已有验收服务商')
    }
    assert.equal(await evaluate('window.piMemeClient.getDefaultModel()'), null)
    if (!initiallyEmpty) {
      await evaluate('document.querySelector("button[aria-label=\\"模型选择\\"]").click()')
      await waitFor(() => evaluate('Boolean(document.querySelector("[role=option]"))'), '默认模型选项')
      await evaluate(
        '[...document.querySelectorAll("[role=option]")].find(node => node.textContent.includes("first")).click()',
      )
      await waitFor(
        () =>
          evaluate(
            'window.piMemeClient.getDefaultModel().then(model => model?.provider === "fake" && model?.id === "first")',
          ),
        '默认模型保存',
      )
    }
    await clickText('添加服务商')
    await waitFor(
      () => evaluate('document.activeElement?.getAttribute("aria-label") === "服务商名称"'),
      '服务商表单焦点',
    )
    await fill('服务商名称', '桌面验收接口')
    await require('./disclosure-smoke.cjs')(window, waitFor, '高级连接设置')
    await evaluate('document.querySelector("button[aria-label=\\"高级连接设置\\"]").click()')
    await fill('服务商 ID', 'desktop-model-test')
    await fill('Base URL', `http://127.0.0.1:${address.port}/v1`)
    await fill('API Key', 'test-key')
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"API Key\\"]").type'), 'password')
    await clickText('获取模型列表')
    await waitFor(
      () => evaluate('Boolean(document.querySelector("[aria-label=\\"选择模型 catalog-test\\"]"))'),
      '远端模型列表',
    )
    await fill('搜索模型', 'catalog-test')
    assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=\\"选择模型 another-model\\"]"))'), false)
    await evaluate('document.querySelector("[aria-label=\\"选择模型 catalog-test\\"]").click()')
    await fill('自定义模型 ID', 'manual-model')
    await clickText('添加模型')
    for (let index = 2; index <= 5; index++) {
      await fill('自定义模型 ID', `manual-model-${index}`)
      await clickText('添加模型')
    }
    await evaluate(
      `document.querySelector('[aria-label="catalog-test contextWindow"]').closest('[role="region"]').parentElement.querySelector('button[aria-expanded]').click()`,
    )
    await fill('catalog-test contextWindow', '64000')
    await fill('catalog-test compat JSON', '{"supportsDeveloperRole":false}')
    await capture('model-config-editor')
    window.setSize(760, 640)
    await waitFor(() => evaluate('window.innerWidth < 800'), '小窗口模型配置')
    await capture('model-config-small')
    assert.equal(
      await evaluate(
        'document.querySelector("[aria-label=\\"模型服务商配置\\"]").getBoundingClientRect().right <= window.innerWidth',
      ),
      true,
    )
    assert.equal(
      await evaluate(
        'document.querySelector("[aria-label=\\"模型配置内容\\"] [data-radix-scroll-area-viewport]").scrollHeight > document.querySelector("[aria-label=\\"模型配置内容\\"] [data-radix-scroll-area-viewport]").clientHeight',
      ),
      true,
    )
    await evaluate(
      'document.querySelector("[aria-label=\\"manual-model-5 maxTokens\\"]").closest("[role=region]").parentElement.querySelector("button[aria-expanded]").click()',
    )
    assert.equal(
      await evaluate(`(() => {
      const container = document.querySelector('[aria-label="模型配置内容"] [data-radix-scroll-area-viewport]');
      container.scrollTop = container.scrollHeight;
      const bounds = container.getBoundingClientRect();
      const bottom = document.querySelector('[aria-label="manual-model-5 思考等级映射 JSON"]').getBoundingClientRect();
      return container.scrollTop > 0 && bottom.top >= bounds.top && bottom.bottom <= bounds.bottom;
    })()`),
      true,
      '弹窗必须实际滚到最后一个模型参数',
    )
    await capture('model-config-scrolled-bottom')
    await clickText('保存服务商')
    await waitFor(
      () =>
        evaluate(
          '!document.querySelector("[aria-label=\\"模型服务商配置\\"]") && document.body.innerText.includes("桌面验收接口")',
        ),
      '服务商保存',
    )
    await waitFor(
      () =>
        evaluate(
          'window.piMemeClient.getSnapshot().then(snapshot => snapshot.models.some(model => model.id === "manual-model"))',
        ),
      '保存后刷新 Pi 模型',
    )
    await clickText('返回聊天')
    await waitFor(
      () =>
        evaluate(
          'Boolean(document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]") && !document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]").disabled)',
        ),
      '首次保存模型后聊天模型选择器启用',
    )
    await evaluate('document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=slider]"))'), '聊天模型思考强度面板')
    await evaluate(
      '[...document.querySelectorAll("[role=dialog] button")].find(node => !node.getAttribute("aria-label")).click()',
    )
    await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=可用模型]"))'), '首次保存模型列表')
    assert.equal(
      await evaluate(
        '[...document.querySelectorAll("[aria-label=可用模型] button")].some(node => node.textContent.includes("manual-model"))',
      ),
      true,
    )
    await evaluate(
      '[...document.querySelectorAll("[aria-label=可用模型] button")].find(node => node.textContent.includes("manual-model")).click()',
    )
    await waitFor(
      () => evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.state.model?.id === "manual-model")'),
      '首次保存模型后选择并应用',
    )
    await waitFor(
      () =>
        evaluate(
          `(() => {
            const trigger = document.querySelector('button[aria-label="选择模型与思考强度"]');
            return Boolean(trigger && !trigger.disabled && trigger.getAttribute('aria-expanded') === 'true' && document.querySelector('[role=slider]'));
          })()`,
        ),
      '模型应用完成后关闭按钮可用',
    )
    await evaluate('document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]").click()')
    await waitFor(() => evaluate('!document.querySelector("[role=slider]")'), '关闭聊天模型选择器')
    await evaluate('document.querySelector("button[aria-label=设置]").click()')
    await clickText('模型')
    await waitFor(() => evaluate('document.body.innerText.includes("桌面验收接口")'), '返回模型设置')
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('div')].reverse().find(node => node.textContent.includes('桌面验收接口') && node.querySelector('button'));
      [...card.querySelectorAll('button')].find(node => node.textContent.trim() === '编辑').click();
    })()`)
    await waitFor(
      () => evaluate('Boolean(document.querySelector("[aria-label=\\"模型服务商配置\\"]"))'),
      '编辑已有服务商',
    )
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"API Key\\"]").value'), '')
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"服务商 ID\\"]").readOnly'), true)
    await fill('服务商名称', '已编辑接口')
    await evaluate(
      'document.querySelector("[aria-label=\\"服务商名称\\"]").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))',
    )
    await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=放弃模型配置修改]"))'), '未保存修改提示')
    await clickText('继续编辑')
    await clickText('保存服务商')
    await waitFor(
      () =>
        evaluate(
          '!document.querySelector("[aria-label=\\"模型服务商配置\\"]") && document.body.innerText.includes("已编辑接口")',
        ),
      '编辑服务商保存',
    )
    await clickText('添加服务商')
    await waitFor(
      () => evaluate('document.activeElement?.getAttribute("aria-label") === "服务商名称"'),
      '添加恢复用服务商表单焦点',
    )
    await fill('服务商名称', '恢复用服务商')
    await fill('服务商 ID', 'fallback-service')
    await fill('Base URL', `http://127.0.0.1:${address.port}/v1`)
    await fill('API Key', 'test-key')
    await fill('自定义模型 ID', 'fallback-model')
    await clickText('添加模型')
    await clickText('保存服务商')
    await waitFor(() => evaluate('document.body.innerText.includes("恢复用服务商")'), '保存恢复用服务商')
    await capture('model-config-list')
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('div')].reverse().find(node => node.textContent.includes('已编辑接口') && node.querySelector('button'));
      [...card.querySelectorAll('button')].find(node => node.textContent.trim() === '删除').click();
    })()`)
    await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=删除模型服务商]"))'), '删除确认')
    await clickText('确认删除')
    await waitFor(
      () =>
        evaluate('!document.body.innerText.includes("已编辑接口") && document.body.innerText.includes("恢复用服务商")'),
      '删除服务商',
    )
    assert.equal(
      await evaluate('document.querySelector("button[aria-label=\\"模型选择\\"]")?.disabled'),
      false,
      '模型失效后默认模型选择仍可用',
    )
    await clickText('返回聊天')
    await waitFor(
      () =>
        evaluate(
          'Boolean(document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]") && !document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]").disabled)',
        ),
      '模型失效后聊天模型选择器仍可用',
    )
    await evaluate('document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]").click()')
    await waitFor(() => evaluate('Boolean(document.querySelector("[role=slider]"))'), '恢复用服务商思考强度面板')
    await evaluate(
      '[...document.querySelectorAll("[role=dialog] button")].find(node => node.textContent.includes("manual-model")).click()',
    )
    await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=可用模型]"))'), '恢复用模型列表')
    assert.equal(
      await evaluate(
        '[...document.querySelectorAll("[aria-label=可用模型] button")].some(node => node.textContent.includes("fallback-model"))',
      ),
      true,
      '模型失效后应显示其他可用模型',
    )
    await evaluate(
      '[...document.querySelectorAll("[aria-label=可用模型] button")].find(node => node.textContent.includes("fallback-model")).click()',
    )
    await waitFor(
      () =>
        evaluate('window.piMemeClient.getSnapshot().then(snapshot => snapshot.state.model?.id === "fallback-model")'),
      '重新选择可用模型',
    )
    await waitFor(
      () =>
        evaluate(
          `(() => {
            const trigger = document.querySelector('button[aria-label="选择模型与思考强度"]');
            return Boolean(trigger && !trigger.disabled && trigger.getAttribute('aria-expanded') === 'true' && document.querySelector('[role=slider]'));
          })()`,
        ),
      '模型应用完成后关闭按钮可用',
    )
    await evaluate('document.querySelector("button[aria-label=\\"选择模型与思考强度\\"]").click()')
    await waitFor(() => evaluate('!document.querySelector("[role=slider]")'), '关闭聊天模型选择器')
    assert.equal(
      await evaluate(
        `window.piMemeClient.getSnapshot().then(snapshot => snapshot.models.some(model => model.id === "fallback-model") && ${initiallyEmpty ? 'snapshot.models.length === 1' : 'snapshot.models.some(model => model.id === "first")'})`,
      ),
      true,
      '删除后保留其余可用模型',
    )
  } finally {
    window.setSize(...originalSize)
    await new Promise((resolve) => server.close(resolve))
  }
}
