import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { windowsRuntimeReadPaths, requireWindowsSandbox } from '@pi-meme/windows-native/sandbox'
import { windowsNodeExecutable } from '@pi-meme/windows-native/runtime'
import type { WindowsSandboxPolicy } from '@pi-meme/windows-native/process'
import type { AccessSandboxOptions } from './access-sandbox'
import { pathWithin } from './access-sandbox'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

export async function windowsSandboxPolicy(options: AccessSandboxOptions): Promise<WindowsSandboxPolicy> {
  if (options.mode === 'full-access')
    throw new Error('sandbox-unavailable: Windows PSEC 尚不能兑现 Full 广泛写入与私有根拒绝的组合')
  await requireWindowsSandbox()
  const read = [options.cwd, options.temporary, ...(await windowsRuntimeReadPaths(await windowsNodeExecutable()))]
  const deny: string[] = []
  for (const directory of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (directory) read.push(await realpath(directory))
  }
  if (options.dataRoot) {
    const root = await realpath(options.dataRoot)
    if (options.mode === 'workspace-write' && pathWithin(options.cwd, root))
      throw new Error('Windows 受限写入的项目不能包含应用数据目录，请将应用数据移到项目外')
    if (pathWithin(options.cwd, root)) deny.push(root)
    const attachments = path.join(root, storageLayoutRelativePaths.attachmentsDirectory)
    try {
      read.push(await realpath(attachments))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  try {
    await access(options.agentDir)
    if (options.mode === 'workspace-write' && pathWithin(options.cwd, await realpath(options.agentDir)))
      throw new Error('Windows 受限写入的项目不能包含 Pi 配置目录，请将配置移到项目外')
    if (pathWithin(options.cwd, await realpath(options.agentDir))) deny.push(await realpath(options.agentDir))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  for (const candidate of options.protectedRoots ?? []) {
    let root: string
    try {
      root = await realpath(candidate)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      root = path.resolve(candidate)
    }
    if (pathWithin(root, options.cwd) || pathWithin(root, options.temporary))
      throw new Error('sandbox-unavailable: Windows 工作区或临时目录位于受保护目录内')
    if (options.mode === 'workspace-write' && pathWithin(options.cwd, root))
      throw new Error('sandbox-unavailable: Windows 可写工作区不能包含受保护目录')
    deny.push(root)
  }
  for (const candidate of options.readOnlyRoots ?? []) {
    let root: string
    try {
      root = await realpath(candidate)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      root = path.resolve(candidate)
    }
    if (
      pathWithin(root, options.temporary) ||
      (options.mode === 'workspace-write' && (pathWithin(root, options.cwd) || pathWithin(options.cwd, root)))
    )
      throw new Error('sandbox-unavailable: Windows 可写目录与只读运行时重叠，拒绝扩大写入权限')
    read.push(root)
  }
  for (const root of options.readableRoots ?? []) {
    if (deny.some((privateRoot) => pathWithin(privateRoot, root)))
      throw new Error('sandbox-unavailable: Windows PSEC 当前不能在私有拒绝根内开放资源读取例外')
    read.push(root)
  }
  return {
    read: [...new Set(read)],
    write: [options.temporary, ...(options.mode === 'workspace-write' ? [options.cwd] : [])],
    deny,
    allowNetwork: options.taskMode !== 'plan' && options.network !== 'deny',
    allowChildren: true,
  }
}
