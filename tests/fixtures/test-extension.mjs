// @ts-check
// 测试扩展：按提示词内容触发弹窗或异常，用来验证桌面端会话级扩展行为。

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 */
export default function testExtension(pi) {
  pi.on(
    'before_agent_start',
    async (/** @type {import('@earendil-works/pi-coding-agent').BeforeAgentStartEvent} */ event, ctx) => {
      if (event.messageType !== 'user') return {}
      if (event.prompt.includes('扩展任务')) await ctx.ui.confirm('后台确认', '确认继续？')
      if (event.prompt.includes('扩展异常')) throw new Error('扩展故意失败')
      return {}
    },
  )
}
