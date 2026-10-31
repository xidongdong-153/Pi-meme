import type { BashOperations, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { AccessSandboxOperations as AccessSandbox } from '../sdk/access-sandbox'
import type { PiSdk } from '../sdk/load'
import { collaborationToolNames } from './plan-mode'
import { createTurnChangesExtension } from './turn-changes'
import { shellCommand } from '../sdk/command-shell'

const allowedTools = new Set([
  'system_read',
  'system_write',
  'read',
  'bash',
  'powershell',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'codemode',
  ...collaborationToolNames,
  'request_user_input',
  'save_visualization',
  'read_visualization',
  'save_plan',
  'manage_service',
  'image_gen',
])

/**
 * 受限权限会话的扩展工厂：替换 bash/写入/编辑工具，让所有落盘操作经过沙箱，
 * 并在会话内限制可用工具。沙箱在创建会话前已经过原生命令启动校验。
 *
 * 参数由 `SdkSession` 按会话传入，不使用环境变量（同进程多会话时环境变量是进程级）。
 */
export function createAgentAccessExtension(options: {
  sdk: PiSdk
  sandbox: AccessSandbox
  cwd: string
  mode: AgentAccessMode
  externalToolAllowed?: (name: string) => boolean
}): InlineExtension {
  const { sdk, sandbox, cwd, mode } = options
  return {
    name: 'pi-desktop-access',
    factory: (pi: ExtensionAPI) => {
      const bashOperations: BashOperations = {
        exec: async (command, directory, runOptions) => {
          const shell = await shellCommand(command)
          return sandbox.run(shell.executable, shell.args, { ...runOptions, cwd: directory })
        },
      }
      pi.registerTool(
        process.platform === 'win32'
          ? sdk.createPowerShellToolDefinition(cwd, { operations: bashOperations })
          : sdk.createBashToolDefinition(cwd, { operations: bashOperations }),
      )
      createTurnChangesExtension(sdk, cwd, sandbox).factory(pi)
      const isAllowed = (name: string) =>
        (process.platform !== 'win32' || name !== 'bash') &&
        (allowedTools.has(name) || options.externalToolAllowed?.(name) === true)
      pi.on('session_start', () => {
        pi.setActiveTools(pi.getActiveTools().filter(isAllowed))
      })
      pi.on('before_agent_start', () => ({
        message: {
          customType: 'pi-desktop-access',
          content:
            process.platform === 'win32'
              ? `当前 Windows 权限：${mode === 'read-only' ? '只读，项目文件禁止修改' : `工作区写入，仅 ${sandbox.workspace} 与会话临时目录可写`}。命令只能读取项目、系统和运行时目录，联网受 Windows 沙箱策略约束。工具授权和规划模式规则继续生效。`
              : mode === 'read-only'
                ? 'Access mode: read-only. Reading files and network access are allowed; modifying local project files is not. Tool availability and Plan-mode restrictions still apply.'
                : `Access mode: workspace-write. Writes are limited to ${sandbox.workspace} and the session temporary directory. Reading and network access are not restricted by this access mode. Other tool and task-mode restrictions still apply.`,
          display: false,
        },
      }))
      pi.on('tool_call', (event) => {
        if (!isAllowed(event.toolName)) throw new Error(`受限权限不允许执行工具：${event.toolName}`)
      })
      pi.on('user_bash', () => ({ operations: bashOperations }))
      pi.on('session_shutdown', () => sandbox.stopAll())
    },
  }
}
