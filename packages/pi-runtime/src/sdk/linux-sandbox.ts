import { access, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'
import type { AccessSandboxOptions, SandboxLaunch } from './access-sandbox'
import { pathWithin } from './access-sandbox'

/** mountinfo 中的路径使用八进制转义；按实际 drvfs 挂载识别 Windows 盘。 */
export function windowsMounts(mountinfo: string): string[] {
  return mountinfo.split('\n').flatMap((line) => {
    const [mount, filesystem] = line.split(' - ')
    if (!filesystem || !(/^(?:drvfs|9p) /.test(filesystem) && /drvfs|[a-z]:[\\/]/i.test(filesystem))) return []
    const destination = mount.split(' ')[4]
    return destination
      ? [destination.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(Number.parseInt(digits, 8)))]
      : []
  })
}

/** Linux seccomp_data 与经典 BPF 的布局固定；未知架构拒绝启用。 */
export function unixSocketFilter(architecture = process.arch): Buffer {
  const native = architecture === 'x64' ? 0xc000003e : architecture === 'arm64' ? 0xc00000b7 : undefined
  if (native === undefined) throw new Error(`Linux 沙箱尚未验证该 CPU 架构：${architecture}`)
  type Instruction = [number, number, number, number]
  const body = (sockets: number[], denyCalls: number[]): Instruction[] => {
    const result: Instruction[] = [
      [0x20, 0, 0, 0],
      [0x45, 0, 1, 0x40000000],
      [0x06, 0, 0, 0x00050001],
    ]
    for (const syscall of denyCalls) result.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001])
    for (const syscall of sockets)
      result.push(
        [0x15, 0, 4, syscall],
        [0x20, 0, 0, 16],
        [0x15, 0, 1, 1],
        [0x06, 0, 0, 0x00050001],
        [0x06, 0, 0, 0x7fff0000],
      )
    result.push([0x06, 0, 0, 0x7fff0000])
    return result
  }
  const nativeBody = body(architecture === 'x64' ? [41, 53] : [198, 199], [425])
  const instructions: Instruction[] = [[0x20, 0, 0, 4], [0x15, 0, nativeBody.length, native], ...nativeBody]
  if (architecture === 'x64') {
    // i386 socketcall 与 io_uring 可绕过直接 socket 参数检查；x32 高位 syscall 全部拒绝。
    const compatible = body([359, 360], [102, 425])
    instructions.push([0x15, 0, compatible.length, 0x40000003], ...compatible)
  }
  instructions.push([0x06, 0, 0, 0x80000000])
  const filter = Buffer.alloc(instructions.length * 8)
  instructions.forEach(([code, yes, no, value], index) => {
    filter.writeUInt16LE(code, index * 8)
    filter[index * 8 + 2] = yes
    filter[index * 8 + 3] = no
    filter.writeUInt32LE(value, index * 8 + 4)
  })
  return filter
}

export async function linuxSandboxLaunch(options: AccessSandboxOptions, fileNode?: string): Promise<SandboxLaunch> {
  await access('/usr/bin/bwrap')
  const drives = windowsMounts(await readFile('/proc/self/mountinfo', 'utf8'))
  if (drives.some((root) => pathWithin(root, options.cwd) || pathWithin(root, options.temporary)))
    throw new Error('受限工作区和临时目录必须位于 Linux 文件系统，请将 Windows 驱动器上的项目移入 Linux 用户目录')
  const args = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--disable-userns',
    '--cap-drop',
    'ALL',
    '--new-session',
    '--die-with-parent',
    options.mode === 'full-access' ? '--bind' : '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/run',
  ]
  if (options.mode !== 'full-access') args.push('--tmpfs', '/tmp', '--tmpfs', '/var/tmp')
  if (options.taskMode === 'plan' || options.network === 'deny') args.push('--unshare-net')
  const privateRoots: string[] = []
  for (const root of [options.agentDir, options.dataRoot, ...(options.protectedRoots ?? [])]) {
    if (!root) continue
    try {
      privateRoots.push(await realpath(root))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  const hiddenRoots = [...new Set([...drives, '/run', '/mnt/wslg'])]
  for (const root of hiddenRoots) {
    try {
      await access(root)
    } catch {
      continue
    }
    if (root !== '/run') args.push('--tmpfs', root, '--remount-ro', root)
  }
  try {
    await access('/init')
    args.push('--ro-bind', '/dev/null', '/init')
  } catch {
    /* 原生 Linux 没有 WSL 入口。 */
  }
  // /etc/resolv.conf 可能指向 /run；用真实源文件覆盖，保留 DNS。
  const resolver = await realpath('/etc/resolv.conf')
  args.push('--ro-bind', resolver, resolver)
  const nodeDirectory = path.dirname(await realpath(process.execPath))
  if (options.mode !== 'full-access' && (pathWithin('/tmp', nodeDirectory) || pathWithin('/var/tmp', nodeDirectory)))
    args.push('--ro-bind', nodeDirectory, nodeDirectory)
  if (options.mode !== 'full-access') {
    args.push('--ro-bind', options.cwd, options.cwd)
    if (options.mode === 'workspace-write') args.push('--bind', options.cwd, options.cwd)
  }
  const overlays: Array<{ root: string; mode: 'private' | 'read' | 'write' }> = privateRoots.map((root) => ({
    root,
    mode: 'private',
  }))
  for (const candidate of options.readOnlyRoots ?? []) {
    try {
      const root = await realpath(candidate)
      // Read-only code does not create a read exception inside a private root.
      if (!privateRoots.some((privateRoot) => pathWithin(privateRoot, root))) overlays.push({ root, mode: 'read' })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  if (privateRoots.some((root) => pathWithin(root, options.cwd))) {
    const immutable = options.readOnlyRoots?.some((root) => pathWithin(root, options.cwd))
    overlays.push({ root: options.cwd, mode: options.mode !== 'read-only' && !immutable ? 'write' : 'read' })
  }
  const readable = [...(options.readableRoots ?? []), ...(fileNode ? [fileNode] : [])]
  if (options.dataRoot) {
    const attachments = path.join(await realpath(options.dataRoot), storageLayoutRelativePaths.attachmentsDirectory)
    try {
      const resolved = await realpath(attachments)
      if (resolved !== attachments) throw new Error('附件目录不能是符号链接')
      readable.push(attachments)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  for (const candidate of readable) {
    try {
      overlays.push({ root: await realpath(candidate), mode: 'read' })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  // Parent mounts precede child masks, so a code/runtime mount cannot reveal a nested private root.
  overlays.sort((a, b) => a.root.length - b.root.length || Number(a.mode === 'private') - Number(b.mode === 'private'))
  for (const overlay of overlays) {
    if (overlay.mode === 'private') args.push('--tmpfs', overlay.root, '--remount-ro', overlay.root)
    else args.push(overlay.mode === 'write' ? '--bind' : '--ro-bind', overlay.root, overlay.root)
  }
  hiddenRoots.push(...privateRoots)
  args.push('--bind', options.temporary, options.temporary)
  if (options.mode !== 'full-access') args.push('--remount-ro', '/tmp', '--remount-ro', '/var/tmp')
  args.push('--remount-ro', '/run', '--chdir', options.cwd, '--seccomp', '3', '--')
  return { executable: '/usr/bin/bwrap', args, seccomp: unixSocketFilter(), hiddenRoots }
}
