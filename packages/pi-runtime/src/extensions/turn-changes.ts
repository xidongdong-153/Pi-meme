import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ExtensionContext, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AccessSandboxOperations } from '../sdk/access-sandbox'
import type { AuthorizedFileMutationReader, AuthorizedFileMutationResolver } from '../sdk/authorized-file-mutation'
import type { PiSdk } from '../sdk/load'
import { recordFileChange, type FileChangeRecord } from '../turn-change-store'
import { generateFilePatch } from '../file-patch'

/** 在 SDK 的文件写入队列内捕获前后内容，直接调用与嵌套调用共用此路径。 */
export function createTurnChangesExtension(
  sdk: PiSdk,
  cwd: string,
  sandbox?: AccessSandboxOperations,
  onSaved?: (entryId: string, revision: string) => void,
  record?: (change: FileChangeRecord) => Promise<string>,
  resolveMutation?: AuthorizedFileMutationResolver,
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
      const approval = (id: string, signal?: AbortSignal) => {
        if (!resolveMutation) throw new Error('permission-denied: 文件修改没有 Host 批准读取器')
        return resolveMutation(id, signal)
      }
      const writer = (
        id: string,
        ctx: ExtensionContext,
        approved: AuthorizedFileMutationReader,
        signal?: AbortSignal,
      ) => {
        const sessionFile = ctx.sessionManager.getSessionFile()
        const userEntry = ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')
        const entryId = userEntry?.id
        return async (target: string, content: string) => {
          if (sandbox) await sandbox.assertWritable(target)
          // edit matching and this snapshot share one authorized FD and bounded buffer.
          const before = await approved.readBefore()
          await approved.assertCurrent(target)
          signal?.throwIfAborted()
          if (!sandbox) throw new Error('controlled-write-unavailable: 缺少受控文件写入后台')
          await sandbox.writeFile(
            target,
            content,
            signal,
            approved.expected
              ? {
                  ...approved.expected,
                  revision: createHash('sha256').update(before!).digest('hex'),
                }
              : null,
          )
          changes.set(id, {
            patch: generateFilePatch(sdk, path.relative(cwd, target), before?.toString('utf8') ?? '', content),
            created: before === null,
          })
          if (sessionFile && entryId) {
            const canonical = approved.canonicalPath
            const after = Buffer.from(content)
            const revision = record
              ? await record({
                  sessionFile,
                  entryId,
                  cwd,
                  target: canonical,
                  before: before?.toString('base64') ?? null,
                  after: after.toString('base64'),
                })
              : await recordFileChange(sessionFile, entryId, cwd, canonical, before, after)
            onSaved?.(entryId, revision)
          }
        }
      }
      const write = sdk.createWriteToolDefinition(cwd)
      pi.registerTool({
        ...write,
        execute: async (id, params, signal, update, ctx) => {
          const approved = approval(id, signal)
          try {
            return await sdk
              .createWriteToolDefinition(cwd, {
                operations: {
                  mkdir: async (directory) => {
                    if (directory !== path.dirname(approved.canonicalPath))
                      throw new Error('permission-denied: 创建目录与 Host 批准目标不匹配')
                    await approved.assertCurrent(approved.canonicalPath)
                    if (!sandbox) throw new Error('controlled-write-unavailable: 缺少受控目录创建后台')
                    await sandbox.mkdir(directory, signal)
                  },
                  writeFile: writer(id, ctx, approved, signal),
                },
              })
              .execute(id, { ...params, path: approved.canonicalPath }, signal, update, ctx)
          } finally {
            await approved.close()
          }
        },
      })
      const edit = sdk.createEditToolDefinition(cwd)
      pi.registerTool({
        ...edit,
        execute: async (id, params, signal, update, ctx) => {
          const approved = approval(id, signal)
          try {
            return await sdk
              .createEditToolDefinition(cwd, {
                operations: {
                  readFile: approved.readFile,
                  access: async (target) => {
                    if (sandbox) await sandbox.assertWritable(target)
                    await approved.access(target)
                  },
                  writeFile: writer(id, ctx, approved, signal),
                },
              })
              .execute(id, { ...params, path: approved.canonicalPath }, signal, update, ctx)
          } finally {
            await approved.close()
          }
        },
      })
    },
  }
}
