import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { windowsRuntimeReadPaths, requireWindowsSandbox } from '@pi-meme/windows-native/sandbox'
import { windowsNodeExecutable } from '@pi-meme/windows-native/runtime'
import type { WindowsSandboxPolicy } from '@pi-meme/windows-native/process'
import type { AccessSandboxOptions } from './access-sandbox'
import { pathWithin } from './access-sandbox'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

export async function windowsSandboxPolicy(options: AccessSandboxOptions): Promise<WindowsSandboxPolicy> {
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
  return {
    read: [...new Set(read)],
    write: [options.temporary, ...(options.mode === 'workspace-write' ? [options.cwd] : [])],
    deny,
    allowNetwork: true,
    allowChildren: true,
  }
}
