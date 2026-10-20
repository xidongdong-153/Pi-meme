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
            'Manage long-running project services owned by the current session. Call list before start to avoid duplicates. Start a foreground command for Web/API previews; do not use &, nohup, daemon mode, or attach an existing PID. Use bash for finite builds and tests. Services survive the assistant reply; do not restart a user-stopped service without explicit permission. A running process or detected URL does not prove application readiness. logs returns only a bounded tail and may be truncated. Unavailable in Plan mode; startup supports macOS and Linux Hosts and obeys the current access policy.',
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
