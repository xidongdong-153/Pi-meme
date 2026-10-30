import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SystemToolRequest } from '@pi-meme/contracts/system-tools'

export function createSystemTools(
  request: (input: SystemToolRequest, signal?: AbortSignal) => Promise<unknown>,
  mode: () => string,
  access: () => string,
): InlineExtension {
  return {
    name: 'pi-meme-system',
    factory: (pi) => {
      for (const write of [false, true])
        pi.registerTool({
          name: write ? 'system_write' : 'system_read',
          label: write ? '操作工作台' : '读取工作台',
          description: write
            ? '操作 Host 内置工具和发起对话的客户端。先用 system_read 的 capabilities 操作查询参数；完全权限下可管理终端、定时任务、素材、资料、MCP、指令、外观和 Desktop 网页。不能用当前界面选择代替会话目标。'
            : '读取 Host 工作台的真实状态。operation=capabilities、args=[] 列出操作和参数。支持读取终端屏幕与输出、定时任务、素材、资料、用量、MCP、指令、项目、会话和 Desktop 网页。默认绑定当前执行会话。',
          parameters: {
            type: 'object',
            properties: {
              operation: { type: 'string', description: '能力目录中的操作名称；首次使用先查询 capabilities。' },
              args: { type: 'array', items: {}, description: '按能力目录列出的顺序提供参数。' },
            },
            required: ['operation', 'args'],
            additionalProperties: false,
          } as ToolDefinition['parameters'],
          execute: async (callId, parameters, signal) => {
            if (write && (mode() === 'plan' || access() !== 'full-access'))
              throw new Error('工作台写操作需要普通模式和完全权限')
            const input = parameters as { operation: string; args: unknown[] }
            const result = await request({ ...input, write, callId }, signal)
            if (result && typeof result === 'object') {
              const value = result as { type?: string; data?: string; mimeType?: string; dataUrl?: string }
              if (value.type === 'image' && value.data && value.mimeType)
                return { content: [{ type: 'image', data: value.data, mimeType: value.mimeType }], details: {} }
              if (value.dataUrl?.startsWith('data:image/png;base64,'))
                return {
                  content: [{ type: 'image', data: value.dataUrl.slice(22), mimeType: 'image/png' }],
                  details: {},
                }
            }
            const json = JSON.stringify(result ?? null)
            return {
              content: [
                {
                  type: 'text',
                  text:
                    json.length > 100_000
                      ? JSON.stringify({
                          truncated: true,
                          message: '结果超过 100000 字符，请缩小查询范围或分页读取。',
                          preview: json.slice(0, 80_000),
                        })
                      : json,
                },
              ],
              details: {},
            }
          },
        })
      pi.on('session_start', () =>
        pi.setActiveTools([
          ...new Set([
            ...pi
              .getActiveTools()
              .filter((name) => name !== 'system_write' || (mode() !== 'plan' && access() === 'full-access')),
            'system_read',
            ...(mode() !== 'plan' && access() === 'full-access' ? ['system_write'] : []),
          ]),
        ]),
      )
    },
  }
}
