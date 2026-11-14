import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { effectiveAgentAccess, isBuiltinAgentToolAllowed, type AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { TaskMode } from '@pi-meme/contracts/plan'
import type { SystemToolRequest } from '@pi-meme/contracts/system-tools'
import { SystemReadError, systemReadTextByteLimit } from '@pi-meme/contracts/system-read'

export function createSystemTools(
  request: (input: SystemToolRequest, signal?: AbortSignal) => Promise<unknown>,
  mode: () => TaskMode,
  access: () => AgentAccessMode,
): InlineExtension {
  return {
    name: 'pi-meme-system',
    factory: (pi) => {
      for (const write of [false, true])
        pi.registerTool({
          name: write ? 'system_write' : 'system_read',
          label: write ? '操作工作台' : '读取工作台',
          description: write
            ? '操作 Host 内置工具和发起对话的客户端。先用 system_read 的 capabilities 操作查询参数；完全权限下可创建聊天、管理项目与会话（命名、配置、置顶、删除），以及终端、定时任务、素材、资料、MCP、指令、外观和 Desktop 网页。不能用当前界面选择代替会话目标。'
            : '读取 Pi meme 的真实配置、状态和保存内容。先调用 capabilities 查询分页目录，再用 capabilities.describe 读取具体参数；目录有 nextCursor 时继续查询。覆盖项目、会话历史与树、队列、子代理、Git、文件、任务、素材、上下文、设置、插件状态和发起客户端。默认绑定执行会话；长结果返回 results.read 续读参数。',
          promptGuidelines: [
            'system_read 先查询 capabilities 和 capabilities.describe；仅使用目录内的操作及明确目标。',
            'system_read 返回 nextCursor、nextOffset 或 continuation 时，按返回参数继续读取；不可把截断或 unknown 当作完整结果。',
          ],
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
            if (
              !isBuiltinAgentToolAllowed(write ? 'system_write' : 'system_read', effectiveAgentAccess(access(), mode()))
            )
              throw new Error('工作台写操作需要普通模式和完全权限')
            const input = parameters as { operation: string; args: unknown[] }
            let result: unknown
            try {
              result = await request({ ...input, write, callId }, signal)
            } catch (cause) {
              if (write) throw cause
              const error =
                cause instanceof SystemReadError
                  ? { code: cause.code, message: cause.message }
                  : { code: 'internal-error', message: '读取失败；未返回内部错误正文' }
              return { content: [{ type: 'text', text: JSON.stringify({ error }) }], details: {}, isError: true }
            }
            if (result && typeof result === 'object') {
              const value = result as { type?: string; data?: string; mimeType?: string; dataUrl?: string }
              const match =
                value.dataUrl && /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value.dataUrl)
              const mimeType = match?.[1] ?? value.mimeType
              const data = match?.[2] ?? (value.type === 'image' ? value.data : undefined)
              if (data && mimeType && /^image\/(?:png|jpeg|gif|webp)$/.test(mimeType)) {
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.byteLength(data, 'base64') > 8 * 1024 * 1024)
                  throw new Error('读取图片无效或超过 8 MiB 限制')
                return { content: [{ type: 'image', data, mimeType }], details: {} }
              }
              if (value.type === 'image' || value.dataUrl?.startsWith('data:image/'))
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        kind: 'unsupported',
                        reason: 'image-format',
                        mimeType: mimeType ?? value.dataUrl?.slice(5, value.dataUrl.indexOf(';')),
                      }),
                    },
                  ],
                  details: {},
                }
            }
            const json = JSON.stringify(result ?? null)
            if (Buffer.byteLength(json, 'utf8') > systemReadTextByteLimit)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      truncated: true,
                      code: 'result-too-large',
                      message: write
                        ? '写操作可能已完成，请使用对应读取操作查询状态，勿直接重复写入。'
                        : '读取结果超过预算，请使用 capabilities.describe 中的分页或分片入口。',
                    }),
                  },
                ],
                details: {},
              }
            return { content: [{ type: 'text', text: json }], details: {} }
          },
        })
      pi.on('session_start', () =>
        pi.setActiveTools([
          ...new Set([
            ...pi
              .getActiveTools()
              .filter(
                (name) =>
                  name !== 'system_write' || isBuiltinAgentToolAllowed(name, effectiveAgentAccess(access(), mode())),
              ),
            'system_read',
            ...(isBuiltinAgentToolAllowed('system_write', effectiveAgentAccess(access(), mode()))
              ? ['system_write']
              : []),
          ]),
        ]),
      )
    },
  }
}
