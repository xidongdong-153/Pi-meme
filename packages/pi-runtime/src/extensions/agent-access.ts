import { readFile } from 'node:fs/promises'
import type { BashOperations, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type { AccessSandbox } from '../sdk/access-sandbox'
import type { PiSdk } from '../sdk/load'

const allowedTools = new Set(['read', 'bash', 'write', 'edit', 'grep', 'find', 'ls', 'codemode'])

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
      pi.on('session_start', () => {
        pi.setActiveTools(pi.getActiveTools().filter((name) => allowedTools.has(name)))
      })
      pi.on('before_agent_start', () => ({
        message: {
          customType: 'pi-desktop-access',
          content:
            mode === 'read-only'
              ? '当前访问权限：仅可查看。允许读取文件和联网，禁止修改本地业务文件。'
              : `当前访问权限：工作区内修改。仅允许修改 ${sandbox.workspace} 和会话临时目录，读取和联网不受限。`,
          display: false,
        },
      }))
      pi.on('tool_call', (event) => {
        if (!allowedTools.has(event.toolName)) throw new Error(`受限权限不允许执行工具：${event.toolName}`)
      })
      pi.on('user_bash', () => ({ operations: bashOperations }))
      pi.on('session_shutdown', () => sandbox.stopAll())
    },
  }
}
