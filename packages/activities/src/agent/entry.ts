import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { ServiceActivityRequest, ServiceActivityResult } from '@pi-meme/contracts/service-activity'

type Context = {
  taskMode: () => 'default' | 'plan'
  requestActivity: (request: ServiceActivityRequest, signal?: AbortSignal) => Promise<ServiceActivityResult>
}

export function create(context: Context): InlineExtension[] {
  return [
    {
      name: 'pi-meme-activities',
      factory: (pi) => {
        pi.registerTool({
          name: 'manage_service',
          label: '管理项目服务',
          description:
            '管理当前会话的长期项目服务。启动前先 list，避免重复启动。command 必须在前台运行，不能使用后台或 daemon 模式，也不能接管已有 PID。Windows command 使用 PowerShell 语法，macOS/Linux 使用 bash。有限构建和测试使用对应命令工具。服务在 Agent 回复后继续运行；用户主动停止的服务未经明确要求不能重启。进程运行或检测到 URL 不代表应用已就绪。logs 只返回有限尾部日志，可能截断。Plan 模式不可用，启动遵守当前权限。',
          parameters: Type.Object(
            {
              action: Type.Union(
                ['start', 'list', 'logs', 'stop'].map((action) => Type.Literal(action)),
                {
                  description:
                    'start requires name and command; logs and stop require serviceId. Call list before starting a service.',
                },
              ),
              name: Type.Optional(
                Type.String({
                  minLength: 1,
                  maxLength: 120,
                  description: 'Display name for the service; required for start.',
                }),
              ),
              command: Type.Optional(
                Type.String({
                  minLength: 1,
                  maxLength: 16384,
                  description: 'Foreground service command; required for start. Do not background or daemonize it.',
                }),
              ),
              cwd: Type.Optional(
                Type.String({
                  minLength: 1,
                  description:
                    'Optional service working directory. Relative paths resolve from the session working directory; omitted means that directory.',
                }),
              ),
              timeout: Type.Optional(
                Type.Integer({
                  minimum: 1,
                  maximum: 2147483,
                  description: '服务运行时限，单位为秒；不传则持续运行。超时后停止整棵进程树。',
                }),
              ),
              serviceId: Type.Optional(
                Type.String({
                  minLength: 1,
                  description:
                    "Service identifier returned by this session's service operations; required for logs and stop.",
                }),
              ),
            },
            { additionalProperties: false },
          ),
          execute: async (toolCallId, input, signal) => {
            if (context.taskMode() === 'plan') throw new Error('规划模式不能管理项目服务')
            let request: ServiceActivityRequest
            if (input.action === 'start') {
              if (!input.name || !input.command) throw new Error('启动服务必须提供 name 和 command')
              request = {
                action: 'start',
                name: input.name,
                command: input.command,
                cwd: input.cwd,
                timeout: input.timeout,
                requestId: toolCallId,
              }
            } else if (input.action === 'list') request = { action: 'list' }
            else if (input.action === 'logs' || input.action === 'stop') {
              if (!input.serviceId) throw new Error('查看日志或停止服务必须提供 serviceId')
              request = { action: input.action, serviceId: input.serviceId }
            } else throw new Error('服务操作无效')
            const result = await context.requestActivity(request, signal)
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
          },
        })
      },
    },
  ]
}
