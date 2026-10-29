import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionContext, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AccessSandboxOperations } from '../sdk/access-sandbox'
import type { PiSdk } from '../sdk/load'
import { recordFileChange } from '../turn-change-store'

/** 在 SDK 的文件写入队列内捕获前后内容，直接调用与嵌套调用共用此路径。 */
export function createTurnChangesExtension(
  sdk: PiSdk,
  cwd: string,
  sandbox?: AccessSandboxOperations,
): Exclude<InlineExtension, (...args: never[]) => unknown> {
  return {
    name: 'pi-meme-turn-changes',
    factory: (pi) => {
      const changes = new Map<string, { patch: string; created: boolean }>()
      pi.on('tool_result', (event) => {
        const change = changes.get(event.toolCallId)
        changes.delete(event.toolCallId)
        if (!change || event.isError) return
        return { details: { ...((event.details as object | undefined) ?? {}), ...change } }
      })
      const writer = (id: string, ctx: ExtensionContext, signal?: AbortSignal) => {
        const sessionFile = ctx.sessionManager.getSessionFile()
        const userEntry = ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')
        const entryId = userEntry?.id
        return async (target: string, content: string) => {
          if (sandbox) await sandbox.assertWritable(target)
          let before: Buffer | null
          try {
            before = await readFile(target)
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
            before = null
          }
          if (sandbox) await sandbox.writeFile(target, content, signal)
          else await writeFile(target, content, 'utf8')
          changes.set(id, {
            patch: sdk.generateUnifiedPatch(path.relative(cwd, target), before?.toString('utf8') ?? '', content),
            created: before === null,
          })
          if (sessionFile && entryId) {
            const canonical = await realpath(target)
            await recordFileChange(sessionFile, entryId, cwd, canonical, before, Buffer.from(content))
          }
        }
      }
      const write = sdk.createWriteToolDefinition(cwd)
      pi.registerTool({
        ...write,
        execute: (id, params, signal, update, ctx) =>
          sdk
            .createWriteToolDefinition(cwd, {
              operations: {
                mkdir: async (directory) => {
                  if (sandbox) await sandbox.mkdir(directory, signal)
                  else await mkdir(directory, { recursive: true })
                },
                writeFile: writer(id, ctx, signal),
              },
            })
            .execute(id, params, signal, update, ctx),
      })
      const edit = sdk.createEditToolDefinition(cwd)
      pi.registerTool({
        ...edit,
        execute: (id, params, signal, update, ctx) =>
          sdk
            .createEditToolDefinition(cwd, {
              operations: {
                readFile,
                access: async (target) => {
                  if (sandbox) await sandbox.assertWritable(target)
                  await access(path.resolve(target), constants.R_OK | constants.W_OK)
                },
                writeFile: writer(id, ctx, signal),
              },
            })
            .execute(id, params, signal, update, ctx),
      })
    },
  }
}
