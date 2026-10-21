import type { ExtensionContext, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentPluginEntry } from '@pi-meme/plugin-sdk/agent'
import type { PluginRuntimeRequest, PluginUiRequest, RestrictedRegistration } from '@pi-meme/contracts/plugin-call'
import type { UserInputQuestion, UserInputResult } from '@pi-meme/contracts/user-input'

export type ExternalToolPolicy = Map<string, { pluginId: string; generation: number; effect: string }>
export function createRestrictedAgent(options: {
  entry: AgentPluginEntry
  request: (request: PluginRuntimeRequest, signal?: AbortSignal) => Promise<unknown>
  registerUi: (id: string, handler: (input: PluginUiRequest) => Promise<unknown>) => void
  requestInput: (questions: UserInputQuestion[], signal?: AbortSignal) => Promise<UserInputResult>
  tools: ExternalToolPolicy
  reservedNames?: ReadonlySet<string>
}): InlineExtension {
  const { entry } = options
  return {
    name: `restricted-agent:${entry.pluginId}:${entry.generation}`,
    factory: async (pi) => {
      let current: ExtensionContext | undefined
      const request = (action: PluginRuntimeRequest['action'], name?: string, input?: unknown, signal?: AbortSignal) =>
        options.request({ pluginId: entry.pluginId, generation: entry.generation, action, name, input }, signal)
      const registration = (await request('initialize')) as RestrictedRegistration
      options.registerUi(entry.pluginId, async (event) => {
        if (event.generation !== entry.generation || !current) throw new Error('scope-expired: 插件交互来源已失效')
        const data = event.input as Record<string, unknown>
        if (event.method === 'interaction')
          return options.requestInput(data.questions as UserInputQuestion[], event.signal ?? current.signal)
        if (event.method === 'notify') {
          if (typeof data.message !== 'string' || !['info', 'warning', 'error'].includes(String(data.level)))
            throw new Error('invalid-input: 通知格式无效')
          current.ui.notify(data.message, data.level as 'info')
          return null
        }
        if (event.method === 'status') {
          if (
            typeof data.key !== 'string' ||
            !data.key ||
            data.key.length > 128 ||
            (data.text !== null && typeof data.text !== 'string')
          )
            throw new Error('invalid-input: 状态格式无效')
          current.ui.setStatus(`${entry.pluginId}:${data.key}`, data.text === null ? undefined : String(data.text))
          return null
        }
        if (event.method === 'message') {
          if (
            typeof data.type !== 'string' ||
            !data.type ||
            /^(?:pi-meme|pi-desktop)[.:_-]/.test(data.type) ||
            typeof data.text !== 'string'
          )
            throw new Error('invalid-input: 插件消息类型或文本无效')
          const type = `${entry.pluginId}:${String(data.type)}`
          pi.registerMessageRenderer(type, () => undefined)
          pi.sendMessage({ customType: type, content: String(data.text), display: true, details: data.data })
          return null
        }
        throw new Error('permission-denied: 插件交互操作无效')
      })
      const hooks = new Set(registration.hooks)
      pi.on('session_start', (_event, context) => {
        current = context
      })
      const reserved = new Set([
        'read',
        'bash',
        'edit',
        'write',
        'grep',
        'find',
        'ls',
        'codemode',
        'tool_search',
        'request_user_input',
        'save_plan',
        'spawn_agent',
        'send_message',
        'wait_agent',
        'finish_agent',
        'list_agents',
        'list_agent_models',
        'followup_task',
        'interrupt_agent',
        'get_goal',
        'update_goal',
        'manage_service',
      ])
      for (const tool of registration.tools) {
        if (reserved.has(tool.name) || options.reservedNames?.has(tool.name) || options.tools.has(tool.name))
          throw new Error('invalid-input: 插件工具名称重复')
        options.tools.set(tool.name, { pluginId: entry.pluginId, generation: entry.generation, effect: tool.effect })
        pi.registerTool({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.parameters as ToolDefinition['parameters'],
          execute: async (_id, parameters, signal, _update, context) => {
            current = context
            const result = (await request(
              'tool',
              tool.name,
              {
                parameters,
                execution: {
                  session: { id: context.sessionManager.getSessionId(), cwd: context.cwd },
                  run: { id: 'host-bound' },
                },
              },
              signal,
            )) as { text: string; data?: import('@pi-meme/plugin-sdk/rpc').JsonValue }
            if (typeof result.text !== 'string') throw new Error('invalid-output: 工具必须返回文本')
            return {
              content: [{ type: 'text', text: result.text }],
              details: result.data,
              ...(result.data === undefined ? {} : { structuredContent: result.data }),
            }
          },
        })
      }
      for (const command of registration.commands) {
        if (reserved.has(command.name) || options.reservedNames?.has(command.name) || options.tools.has(command.name))
          throw new Error('invalid-input: 插件命令名称重复或保留')
        options.tools.set(command.name, {
          pluginId: entry.pluginId,
          generation: entry.generation,
          effect: command.effect,
        })
        pi.registerCommand(command.name, {
          description: command.description,
          handler: async (args, context) => {
            current = context
            await request(
              'command',
              command.name,
              {
                parameters: args,
                execution: { session: { id: context.sessionManager.getSessionId(), cwd: context.cwd } },
              },
              context.signal,
            )
          },
        })
      }
      if (hooks.has('beforeRun'))
        pi.on('before_agent_start', async (event, context) => {
          current = context
          const result = (await request(
            'hook',
            'beforeRun',
            {
              prompt: event.messageType === 'user' ? event.prompt : '',
              session: { id: context.sessionManager.getSessionId(), cwd: context.cwd },
            },
            context.signal,
          )) as Array<{ context?: string } | null>
          const text = result
            .map((v) => v?.context)
            .filter(Boolean)
            .join('\n')
          if (text)
            event.systemPromptOptions.sections.app_plugin_context = [
              event.systemPromptOptions.sections.app_plugin_context,
              text,
            ]
              .filter(Boolean)
              .join('\n')
        })
      if (hooks.has('runStart'))
        pi.on('agent_start', async (_event, context) => {
          current = context
          await request('hook', 'runStart', {}, context.signal)
        })
      pi.on('agent_end', async (_event, context) => {
        try {
          if (hooks.has('runEnd')) await request('hook', 'runEnd', {}, context.signal)
        } finally {
          await request('close')
        }
      })
      pi.on('session_shutdown', async () => {
        for (const tool of [...registration.tools, ...registration.commands]) options.tools.delete(tool.name)
        current = undefined
        await request('close')
      })
    },
  }
}
