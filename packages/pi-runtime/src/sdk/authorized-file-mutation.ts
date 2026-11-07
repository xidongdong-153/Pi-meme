import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { AuthorizedFileMutation } from '@pi-meme/contracts/authorization'
import { createAuthorizedReadOperations, type AuthorizedFileReadBackend } from './authorized-file-read'

export type AuthorizedFileMutationReader = {
  canonicalPath: string
  expected: AuthorizedFileMutation['existing']
  readBefore: () => Promise<Buffer | null>
  readFile: (target: string) => Promise<Buffer>
  access: (target: string) => Promise<void>
  assertCurrent: (target: string) => Promise<void>
  close: () => Promise<void>
}
export type AuthorizedFileMutationResolver = (callId: string, signal?: AbortSignal) => AuthorizedFileMutationReader

/** Consume before SDK dispatch; edit matching and change capture share the approved read FD and buffer. */
export function createAuthorizedFileMutationResolver(
  approvals: Map<string, AuthorizedFileMutation>,
  read: AuthorizedFileReadBackend,
): AuthorizedFileMutationResolver {
  return (callId, signal) => {
    const stored = approvals.get(callId)
    approvals.delete(callId)
    if (!stored) throw new Error('permission-denied: 文件修改缺少 Host 对本次调用的授权')
    const authorization = { ...stored, existing: stored.existing ? { ...stored.existing } : stored.existing }
    const canonicalPath = authorization.canonicalPath
    if (
      !path.isAbsolute(canonicalPath) ||
      canonicalPath.includes('\0') ||
      path.normalize(canonicalPath) !== canonicalPath
    )
      throw new Error('permission-denied: 文件修改必须使用 Host 批准的规范绝对路径')
    if (
      authorization.existing !== null &&
      (!authorization.existing ||
        typeof authorization.existing.dev !== 'string' ||
        typeof authorization.existing.ino !== 'string')
    )
      throw new Error('permission-denied: 文件修改授权缺少对象身份')
    const approved = authorization.existing
      ? createAuthorizedReadOperations({ canonicalPath, ...authorization.existing }, signal, read)
      : undefined
    let closed = false
    const assertTarget = (target: string) => {
      signal?.throwIfAborted()
      if (closed || target !== canonicalPath) throw new Error('permission-denied: 修改目标与 Host 批准不匹配或已释放')
    }
    const assertCurrent = async (target: string) => {
      assertTarget(target)
      let identity
      try {
        identity = await lstat(canonicalPath, { bigint: true })
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && authorization.existing === null) return
        throw cause
      }
      if (authorization.existing === null)
        throw new Error('permission-denied: 新文件目标在授权后已经出现，拒绝读取或覆盖')
      if (
        !identity.isFile() ||
        identity.nlink !== 1n ||
        identity.dev.toString() !== authorization.existing.dev ||
        identity.ino.toString() !== authorization.existing.ino
      )
        throw new Error('permission-denied: 修改目标对象在授权后已变化或存在硬链接')
      await approved!.operations.access(canonicalPath)
    }
    const readBefore = async () => {
      await assertCurrent(canonicalPath)
      if (!approved) return null
      // The ordinary read adapter retains its 64 MiB bound, pre/post fstat and single-link checks.
      const contents = await approved.operations.readFile(canonicalPath)
      await assertCurrent(canonicalPath)
      return contents
    }
    return {
      canonicalPath,
      expected: authorization.existing ? Object.freeze({ ...authorization.existing }) : null,
      readBefore,
      assertCurrent,
      access: async (target) => {
        await assertCurrent(target)
        if (!approved) throw new Error('permission-denied: 编辑目标在 Host 授权时不存在')
      },
      readFile: async (target) => {
        assertTarget(target)
        const before = await readBefore()
        if (!before) throw new Error('permission-denied: 编辑目标在 Host 授权时不存在')
        return before
      },
      close: async () => {
        closed = true
        await approved?.close()
      },
    }
  }
}
