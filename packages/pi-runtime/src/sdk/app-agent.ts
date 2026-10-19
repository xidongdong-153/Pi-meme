import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { ExtensionContext, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  AgentExecutionContext,
  AgentPluginContext,
  AgentPluginEntry,
  AgentPluginModule,
  AgentSession,
} from '@pi-meme/plugin-sdk/agent'
import { PluginScope } from '@pi-meme/plugin-sdk/scope'
import type { UserInputQuestion, UserInputResult } from '@pi-meme/contracts/user-input'

const reservedTools = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'codemode',
  'tool_search',
  'spawn_agent',
  'followup_task',
  'send_message',
  'wait_agent',
  'finish_agent',
  'list_agents',
  'interrupt_agent',
  'save_plan',
  'get_goal',
  'update_goal',
  'request_user_input',
])

export function createAppAgent(
  entry: AgentPluginEntry,
  requestInput: (questions: UserInputQuestion[], signal?: AbortSignal) => Promise<UserInputResult>,
): InlineExtension {
  return {
    name: `app-agent:${entry.pluginId}:${entry.generation}`,
    factory: async (pi) => {
      const module = (await import(pathToFileURL(entry.path).href)) as AgentPluginModule
      if (typeof module.activate !== 'function')
        throw new Error(`AppAgent 必须导出 activate(context)：${entry.pluginId}`)
      const scope = new PluginScope()
      let current: ExtensionContext | undefined
      let runId = randomUUID()
      let runController = new AbortController()
      const session = (context: ExtensionContext): AgentSession => ({
        id: context.sessionManager.getSessionId(),
        cwd: context.cwd,
      })
      const execution = (context: ExtensionContext, signal?: AbortSignal): AgentExecutionContext => ({
        session: session(context),
        run: { id: runId },
        signal: signal ?? context.signal ?? runController.signal,
      })
      const names = new Set<string>()
      const validateName = (name: string) => {
        if (!/^[a-zA-Z][\w-]*$/.test(name) || reservedTools.has(name) || names.has(name))
          throw new Error(`AppAgent 工具或命令名称无效或重复：${name}`)
        names.add(name)
      }
      pi.on('session_start', (_event, context) => {
        current = context
      })
      pi.on('before_agent_start', (_event, context) => {
        current = context
        runId = randomUUID()
        runController = new AbortController()
      })
      const context: AgentPluginContext = {
        pluginId: entry.pluginId,
        generation: entry.generation,
        tools: {
          register: (tool) => {
            validateName(tool.name)
            if (tool.parameters.type !== 'object') throw new Error('AppAgent 工具参数必须是 object JSON Schema')
            pi.registerTool({
              name: tool.name,
              label: tool.title,
              description: tool.description,
              parameters: tool.parameters as ToolDefinition['parameters'],
              execute: async (_id, parameters, signal, _update, ctx) => {
                const result = await tool.execute(parameters as Record<string, unknown>, execution(ctx, signal))
                if (typeof result.text !== 'string') throw new Error('AppAgent 工具必须返回文本结果')
                return {
                  content: [{ type: 'text', text: result.text }],
                  details: result.data,
                  ...(result.data === undefined ? {} : { structuredContent: result.data }),
                }
              },
            })
          },
        },
        hooks: {
          on: (event, handler) => {
            const invoke = (value: unknown) => Reflect.apply(handler, undefined, [value]) as unknown
            let dispose: () => void
            switch (event) {
              case 'sessionStart':
                dispose = pi.on('session_start', async (_event, ctx) => {
                  await invoke({ session: session(ctx) })
                })
                break
              case 'sessionEnd':
                dispose = pi.on('session_shutdown', async (_event, ctx) => {
                  await invoke({ session: session(ctx) })
                })
                break
              case 'runStart':
                dispose = pi.on('agent_start', async (_event, ctx) => {
                  await invoke(execution(ctx))
                })
                break
              case 'runEnd':
                dispose = pi.on('agent_end', async (_event, ctx) => {
                  await invoke(execution(ctx))
                })
                break
              case 'beforeRun':
                dispose = pi.on('before_agent_start', async (event, ctx) => {
                  const content = event.messageType === 'user' ? event.prompt : event.message.content
                  const prompt =
                    typeof content === 'string'
                      ? content
                      : content
                          .filter((part) => part.type === 'text')
                          .map((part) => part.text)
                          .join('\n')
                  const result = (await invoke({ ...execution(ctx), prompt })) as { context?: unknown } | undefined
                  if (result?.context !== undefined) {
                    if (typeof result.context !== 'string') throw new Error('beforeRun 追加上下文必须是字符串')
                    return { systemPrompt: `${event.systemPrompt}\n${result.context}` }
                  }
                  return undefined
                })
                break
              default:
                throw new Error(`AppAgent 生命周期事件无效：${String(event)}`)
            }
            return scope.own(dispose)
          },
        },
        commands: {
          register: (command) => {
            validateName(command.name)
            pi.registerCommand(command.name, {
              description: command.description,
              handler: async (args, ctx) => {
                await command.execute(args, execution(ctx))
              },
            })
          },
        },
        messages: {
          emit: (message) => {
            if (!message.type || /^(?:pi-meme|pi-desktop)[.:_-]/.test(message.type) || typeof message.text !== 'string')
              throw new Error('AppAgent 消息必须提供类型和文本')
            const type = `${entry.pluginId}:${message.type}`
            pi.registerMessageRenderer(type, () => undefined)
            pi.sendMessage({ customType: type, content: message.text, display: true, details: message.data })
          },
        },
        interaction: {
          request: requestInput,
          notify: (message, level) => {
            if (!current) throw new Error('AppAgent 会话尚未启动')
            current.ui.notify(message, level)
          },
          setStatus: (key, text) => {
            if (!current) throw new Error('AppAgent 会话尚未启动')
            current.ui.setStatus(`${entry.pluginId}:${key}`, text)
          },
        },
        onDispose: (dispose) => {
          scope.own(dispose)
        },
      }
      try {
        const dispose = await module.activate(context)
        if (dispose) scope.own(dispose)
        pi.on('agent_end', () => {
          runController.abort()
        })
        pi.on('session_shutdown', async () => {
          runController.abort()
          await scope.dispose()
          current = undefined
        })
      } catch (cause) {
        await scope.dispose()
        throw cause
      }
    },
  }
}
