import type { BashOperations, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { AccessSandboxOperations as AccessSandbox } from '../sdk/access-sandbox'
import type { PiSdk } from '../sdk/load'
import type { AuthorizedFileMutationResolver } from '../sdk/authorized-file-mutation'
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
  'tool_search',
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
 * 并在会话内限制可用工具。固定文件操作与任意进程分别按实际需求校验后端。
 *
 * 参数由 `SdkSession` 按会话传入，不使用环境变量（同进程多会话时环境变量是进程级）。
 */
export function createAgentAccessExtension(options: {
  sdk: PiSdk
  sandbox: AccessSandbox
  fileSandbox?: AccessSandbox
  cwd: string
  mode: AgentAccessMode
  recordTurnChange?: (change: import('../turn-change-store').FileChangeRecord) => Promise<string>
  onTurnSaved?: (entryId: string, revision: string) => void
  externalToolAllowed?: (name: string) => boolean
  resolveFileMutation?: AuthorizedFileMutationResolver
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
      createTurnChangesExtension(
        sdk,
        cwd,
        options.fileSandbox ?? sandbox,
        options.onTurnSaved,
        options.recordTurnChange,
        options.resolveFileMutation,
      ).factory(pi)
      const isAllowed = (name: string) =>
        (process.platform !== 'win32' || name !== 'bash') &&
        (allowedTools.has(name) || options.externalToolAllowed?.(name) === true)
      pi.on('session_start', () => {
        pi.setActiveTools(pi.getActiveTools().filter(isAllowed))
      })
      pi.on('before_agent_start', () => ({
        message: {
          customType: 'pi-desktop-access',
          content: [
            `${process.platform === 'win32' ? '当前 Windows 访问权限' : '当前访问权限'}：${mode}。`,
            mode === 'full-access'
              ? '完全权限允许修改已获准的项目内外业务文件。Host 私有凭据、配置、会话和运行时仍受隔离保护。'
              : mode === 'workspace-write'
                ? `只允许修改工作区 ${sandbox.workspace} 与会话临时目录，Host 私有路径仍受隔离保护。`
                : '只读权限禁止修改项目和其他持久业务文件；Host 明确批准的会话临时产物存储除外。',
            '文件读取、联网和原生命令仍须通过 Host 对本次操作的授权与真实后端能力校验。缺少所需隔离能力时，该操作明确拒绝，不会无沙箱重试。工具范围和规划模式限制继续生效。',
          ].join('\n'),
          display: false,
        },
      }))
      pi.on('tool_call', (event) => {
        if (!isAllowed(event.toolName)) throw new Error(`受限权限不允许执行工具：${event.toolName}`)
      })
      pi.on('user_bash', () => ({ operations: bashOperations }))
      pi.on('session_shutdown', async () => {
        const results = await Promise.allSettled([sandbox.stopAll(), options.fileSandbox?.stopAll()])
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })
    },
  }
}
