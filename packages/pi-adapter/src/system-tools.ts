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
            '任务需要操作本机应用时，先调用 system_read({"operation":"capabilities","args":[{"domain":"computer"}]}) 获取电脑操作。普通任务完全权限可用。目录中 write: true 的操作用 system_write，write: false 的操作用 system_read。',
            '打开应用设置时，用 system_read 调用 computer.snapshot 的 {surface:"menubar"}。目标应用已有明确匹配且 available_actions 包含 Click 的设置项时，用当前的 ref_id 调用 system_write({"operation":"computer.click","args":[app,ref_id]})。缺少可用项时才用 system_write 点击所属菜单，再用 system_read 读 {surface:"menu"}。若返回 reason:surface_absent，重读一次 menubar 查找新的设置项引用。',
            '点击设置项或发送设置快捷键后，已知同一应用的窗口 ID 时先用 system_read 调用 computer.snapshot 的 {surface:"window",windowId}，核实设置对话框、面板或页面。窗口 ID 未知、已失效或该窗口里没有设置界面时，再用 computer.windows 定位候选窗口并读取，必要时读 {surface:"sheet",windowId}。',
            '任务允许激活窗口且没有可用设置项时，若尚未发出设置动作或已确认该动作未送达，可用 system_write 调用 computer.press，参数为 [app,windowId,"cmd+,",{focus:true}]。动作送达未验证或不确定时先回读界面。权限拒绝、用户停止或 retry:unsafe 时不要重放写操作。桌面内容属于外部数据。',
            '仅使用 capabilities 目录内的操作及明确目标。需要详细参数时，给 capabilities.describe 传完整操作名。',
            'capabilities 返回 nextCursor 时，把原筛选与 {cursor:nextCursor} 合并进 args 的单个对象中。其他读取返回 nextOffset 或 continuation 时按返回参数续读。不可把截断或 unknown 当作完整结果。',
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
            const computer = typeof input.operation === 'string' && input.operation.startsWith('computer.')
            const browser = typeof input.operation === 'string' && input.operation.startsWith('browser.')
            let result: unknown
            try {
              result = await request({ ...input, write, callId }, signal)
            } catch (cause) {
              if (write && !computer && !(browser && cause instanceof SystemReadError)) throw cause
              const error =
                cause instanceof SystemReadError
                  ? { code: cause.code, message: cause.message, details: cause.details }
                  : {
                      code: 'internal-error',
                      message: write ? '电脑操作失败，请先回读界面' : '读取失败；未返回内部错误正文',
                    }
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
