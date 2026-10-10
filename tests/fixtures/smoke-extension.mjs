// @ts-check
// 桌面验收扩展：注册验收命令与工具，驱动扩展弹窗、通知、状态、挂件、标题和编辑器文本。
import { Type } from 'typebox'

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 */
export default function smokeExtension(pi) {
  pi.registerCommand('review', {
    description: '检查改动',
    handler: async (_args, ctx) => {
      ctx.ui.notify('检查改动完成', 'info')
    },
  })
  pi.registerCommand('extension-error', {
    description: '触发扩展异常',
    handler: async () => {
      throw new Error('模拟扩展异常')
    },
  })
  pi.registerTool({
    name: 'slow-tool',
    label: '慢工具',
    description: '等待若干秒后返回，用来让会话保持在运行中状态',
    parameters: Type.Object({ seconds: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params, signal) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, (params.seconds ?? 5) * 1000)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve(undefined)
          },
          { once: true },
        )
      })
      return { content: [{ type: 'text', text: signal?.aborted ? '慢工具已停止' : '慢工具完成' }] }
    },
  })
  pi.registerTool({
    name: 'smoke-dialogs',
    label: '扩展验收',
    description: '依次展示扩展弹窗并回填结果，供桌面验收使用',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // 通知、状态、挂件、标题和编辑器文本先于弹窗写入，验收脚本在首个弹窗出现时即可断言。
      ctx.ui.notify('Pi 扩展通知', 'warning')
      ctx.ui.setStatus('build', '准备完成')
      ctx.ui.setWidget('top', ['顶部提示'], { placement: 'aboveEditor' })
      ctx.ui.setWidget('bottom', ['底部提示'], { placement: 'belowEditor' })
      ctx.ui.setTitle('Pi SDK 验收')
      ctx.ui.setEditorText('扩展预填')
      const confirmed = await ctx.ui.confirm('确认', '确认继续执行')
      const environment = await ctx.ui.select('选择环境', ['开发', '生产'])
      const optional = await ctx.ui.input('可取消输入', '可选内容')
      const name = await ctx.ui.input('输入名称', '名称')
      const edited = await ctx.ui.editor('编辑内容', '扩展预填')
      return {
        content: [
          {
            type: 'text',
            text: `确认=${String(confirmed)};环境=${environment ?? '未选择'};可选=${optional ?? '取消'};名称=${name ?? '未填写'};编辑=${edited ?? '未编辑'}`,
          },
        ],
      }
    },
  })
}
