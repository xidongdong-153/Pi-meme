import { readFile } from 'node:fs/promises'
import type { BashOperations, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { AccessSandboxOperations as AccessSandbox } from '../sdk/access-sandbox'
import type { PiSdk } from '../sdk/load'
import { collaborationToolNames } from './plan-mode'

const allowedTools = new Set([
  'read',
  'bash',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'codemode',
  ...collaborationToolNames,
  'request_user_input',
  'save_plan',
  'manage_service',
  'image_gen',
])

/**
 * 受限权限会话的扩展工厂：替换 bash/写入/编辑工具，让所有落盘操作经过沙箱，
 * 并在会话内限制可用工具。沙箱在创建会话前已经过 `/usr/bin/true` 校验。
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
        exec: (command, directory, runOptions) =>
          sandbox.run('/bin/bash', ['-c', command], { ...runOptions, cwd: directory }),
      }
      // 每次调用绑定自己的 AbortSignal，不能共享并行工具的取消状态。
      const writeTool = (signal?: AbortSignal) =>
        sdk.createWriteToolDefinition(cwd, {
          operations: {
            mkdir: (target) => sandbox.mkdir(target, signal),
            writeFile: (target, content) => sandbox.writeFile(target, content, signal),
          },
        })
      const editTool = (signal?: AbortSignal) =>
        sdk.createEditToolDefinition(cwd, {
          operations: {
            readFile: (target) => readFile(target),
            access: (target) => sandbox.assertWritable(target),
            writeFile: (target, content) => sandbox.writeFile(target, content, signal),
          },
        })
      pi.registerTool(sdk.createBashToolDefinition(cwd, { operations: bashOperations }))
      const writeDefinition = sdk.createWriteToolDefinition(cwd)
      pi.registerTool({
        ...writeDefinition,
        execute: (id, params, signal, onUpdate, ctx) => writeTool(signal).execute(id, params, signal, onUpdate, ctx),
      })
      const editDefinition = sdk.createEditToolDefinition(cwd)
      pi.registerTool({
        ...editDefinition,
        execute: (id, params, signal, onUpdate, ctx) => editTool(signal).execute(id, params, signal, onUpdate, ctx),
      })
      const isAllowed = (name: string) => allowedTools.has(name) || options.externalToolAllowed?.(name) === true
      pi.on('session_start', () => {
        pi.setActiveTools(pi.getActiveTools().filter(isAllowed))
      })
      pi.on('before_agent_start', () => ({
        message: {
          customType: 'pi-desktop-access',
          content:
            mode === 'read-only'
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
