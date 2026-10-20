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
            '启动、查看或停止当前会话的常驻项目服务。需要 Web/API 预览时使用 start；构建和测试仍用 bash。start 传前台命令，不使用 &、nohup 或 daemon，不接管已有 PID。服务在回复结束后继续运行，用户可在活动面板停止。启动前先 list 检查已有服务；用户停止后不得擅自重启。logs 只返回有限日志尾部。规划模式禁止调用。',
          parameters: Type.Object(
            {
              action: Type.Union(['start', 'list', 'logs', 'stop'].map((action) => Type.Literal(action))),
              name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
              command: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
              cwd: Type.Optional(Type.String({ minLength: 1 })),
              serviceId: Type.Optional(Type.String({ minLength: 1 })),
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
