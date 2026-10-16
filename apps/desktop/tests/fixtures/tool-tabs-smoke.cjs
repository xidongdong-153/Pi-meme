async function openTool(window, waitFor, title) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  await evaluate(`document.querySelector('button[aria-label="展开右侧栏"]')?.click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('#workspace-right-sidebar'))`), '右侧工具栏')
  const hasTab = await evaluate(`(() => {
    const tabs = document.querySelector('[role="tablist"][aria-label="右侧栏标签"]');
    const tab = [...tabs.querySelectorAll('[role="tab"]')].find(node => node.textContent.includes(${JSON.stringify(title)}));
    if (!tab) return false; tab.click(); return true;
  })()`)
  if (!hasTab) {
    const choosing = await evaluate(
      `document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]') !== null`,
    )
    if (!choosing) await evaluate(`document.querySelector('button[aria-label="新建工具标签页"]').click()`)
    await waitFor(
      () =>
        evaluate(`(() => {
      const page = document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]');
      return page && [...page.querySelectorAll('button')].some(node => node.textContent.includes(${JSON.stringify(title)}) && !node.disabled);
    })()`),
      `工具选择项：${title}`,
    )
    await evaluate(`(() => {
      const page = document.querySelector('#workspace-right-sidebar [role="tabpanel"][aria-label="新标签页"]');
      [...page.querySelectorAll('button')].find(node => node.textContent.includes(${JSON.stringify(title)}) && !node.disabled).click();
    })()`)
  }
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('[role="tablist"][aria-label="右侧栏标签"] [role="tab"][aria-selected="true"]')?.textContent.includes(${JSON.stringify(title)})`,
      ),
    `激活工具标签：${title}`,
  )
}
module.exports = { openTool }
