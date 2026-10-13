// @ts-check
// 桌面验收 App 插件：命令、慢工具、多题交互、通知、状态与结构化消息。

/** @param {import('@pi-meme/plugin-sdk/agent').AgentPluginContext} context */
export function activate(context) {
  context.commands.register({
    name: 'review',
    description: '检查改动',
    execute: async () => {
      context.interaction.notify('检查改动完成')
    },
  })
  context.commands.register({
    name: 'extension-error',
    description: '触发插件异常',
    execute: async () => {
      throw new Error('模拟插件异常')
    },
  })
  context.tools.register({
    name: 'slow-tool',
    title: '慢工具',
    description: '等待若干秒后返回，供桌面验收检查运行状态。',
    parameters: { type: 'object', properties: { seconds: { type: 'number' } }, additionalProperties: false },
    async execute(parameters, execution) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, (typeof parameters.seconds === 'number' ? parameters.seconds : 5) * 1000)
        execution.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve(undefined)
          },
          { once: true },
        )
      })
      return { text: execution.signal.aborted ? '慢工具已停止' : '慢工具完成' }
    },
  })
  context.tools.register({
    name: 'smoke-dialogs',
    title: 'App 交互验收',
    description: '依次显示多题交互并返回回答。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_parameters, execution) {
      context.interaction.notify('App 插件通知', 'warning')
      context.interaction.setStatus('build', '准备完成')
      const choices = await context.interaction.request(
        [
          { id: 'confirm', question: '确认继续执行', options: [{ label: '确认' }, { label: '取消' }] },
          { id: 'environment', question: '选择环境', options: [{ label: '开发' }, { label: '生产' }] },
          { id: 'optional', question: '可取消输入' },
        ],
        execution.signal,
      )
      const textAnswers = choices.cancelled
        ? { answers: [], cancelled: true }
        : await context.interaction.request(
            [
              { id: 'name', question: '输入名称' },
              { id: 'content', question: '编辑内容' },
            ],
            execution.signal,
          )
      const result = {
        answers: [...choices.answers, ...textAnswers.answers],
        cancelled: choices.cancelled || textAnswers.cancelled,
      }
      const values = Object.fromEntries(result.answers.map((answer) => [answer.id, answer.value]))
      const text = `确认=${values.confirm ?? '取消'};环境=${values.environment ?? '未选择'};可选=${values.optional ?? '跳过'};名称=${values.name ?? '未填写'};编辑=${values.content ?? '未填写'}`
      context.messages.emit({
        type: 'smoke-dialog-result',
        text: `App 交互完成：${text}`,
        data: { answers: result.answers, cancelled: result.cancelled },
      })
      return { text, data: { answers: result.answers, cancelled: result.cancelled } }
    },
  })
}
