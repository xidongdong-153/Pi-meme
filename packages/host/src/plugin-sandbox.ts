import { access, realpath, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { unixSocketFilter, windowsMounts } from '@pi-meme/pi-runtime/sdk/linux-sandbox'
import type { RestrictedLaunchOptions, RestrictedLaunch } from '@pi-meme/plugin-runtime/restricted-runner'
import { storageLayoutRelativePaths } from '@pi-meme/contracts/storage-paths'

function within(root: string, value: string) {
  const relative = path.relative(root, value)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
export async function pluginSandboxLaunch(options: RestrictedLaunchOptions): Promise<RestrictedLaunch> {
  if (!options.node)
    throw new Error(
      'sandbox-unavailable: 缺少固定 Node 运行时，请准备资源并设置 PI_MEME_PLUGIN_NODE 与 PI_MEME_PLUGIN_ENTRY',
    )
  const node = await realpath(options.node)
  const workspace = await realpath(options.workspace)
  const directory = await realpath(options.directory)
  const scratch = await realpath(options.scratch)
  const entry = await realpath(options.entry)
  const dataRoot = options.dataRoot ? await realpath(options.dataRoot) : undefined
  const standaloneWorkspaces = dataRoot
    ? path.join(dataRoot, storageLayoutRelativePaths.standaloneWorkspacesDirectory)
    : ''
  if (
    dataRoot &&
    within(dataRoot, workspace) &&
    (workspace === dataRoot || workspace === standaloneWorkspaces || !within(standaloneWorkspaces, workspace))
  )
    throw new Error('sandbox-unavailable: 不能将 Host 数据目录授权为插件工作区')
  if (workspace === path.parse(workspace).root || workspace === (await realpath(homedir())))
    throw new Error('sandbox-unavailable: 请选择具体项目目录')
  const reads = [...new Set([node, directory, entry, scratch, ...(options.readable === false ? [] : [workspace])])]
  const nodeArgs = [
    '--no-addons',
    '--permission',
    ...reads.map((p) => `--allow-fs-read=${p}`),
    `--allow-fs-write=${scratch}`,
    ...(options.writable ? [`--allow-fs-write=${workspace}`] : []),
    entry,
  ]
  const env: NodeJS.ProcessEnv = { HOME: scratch, TMPDIR: scratch, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }
  if (process.platform === 'linux') {
    await access('/usr/bin/bwrap')
    const drives = windowsMounts(await readFile('/proc/self/mountinfo', 'utf8'))
    if (drives.some((d) => within(d, workspace)))
      throw new Error('sandbox-unavailable: 受限插件项目必须位于 Linux 文件系统')
    const args = [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-net',
      '--disable-userns',
      '--cap-drop',
      'ALL',
      '--new-session',
      '--die-with-parent',
      '--clearenv',
    ]
    for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value!)
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run')
    for (const lib of ['/usr/lib', '/lib', '/lib64']) {
      try {
        await access(lib)
        args.push('--ro-bind', lib, lib)
      } catch {
        /* 当前发行版不一定有 lib64。 */
      }
    }
    args.push('--ro-bind', node, node, '--ro-bind', entry, entry, '--ro-bind', directory, directory)
    if (options.readable !== false) args.push(options.writable ? '--bind' : '--ro-bind', workspace, workspace)
    else args.push('--dir', workspace)
    const maskRoot = options.readable !== false && dataRoot && within(workspace, dataRoot)
    if (maskRoot) args.push('--tmpfs', dataRoot)
    args.push('--ro-bind', node, node, '--ro-bind', entry, entry, '--ro-bind', directory, directory)
    if (maskRoot) args.push('--remount-ro', dataRoot)
    args.push('--bind', scratch, scratch, '--chdir', workspace, '--seccomp', '3', '--', node, ...nodeArgs)
    return { executable: '/usr/bin/bwrap', args, env, seccomp: unixSocketFilter() }
  }
  if (process.platform === 'darwin') {
    await access('/usr/bin/sandbox-exec')
    const readRules = reads.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ')
    const writeRules = [scratch, ...(options.writable ? [workspace] : [])]
      .map((p) => `(subpath ${JSON.stringify(p)})`)
      .join(' ')
    const protectedRule = dataRoot
      ? `(deny file-read* file-write* (require-all (subpath ${JSON.stringify(dataRoot)}) (require-not (subpath ${JSON.stringify(directory)})) ${within(dataRoot, workspace) ? `(require-not (subpath ${JSON.stringify(workspace)}))` : ''}))`
      : ''
    const profile = [
      '(version 1)',
      '(deny default)',
      `(allow process-exec (literal ${JSON.stringify(node)}))`,
      '(deny process-fork)',
      '(allow sysctl-read)',
      '(allow mach-lookup (global-name "com.apple.system.logger"))',
      '(allow file-read-metadata)',
      // macOS 动态链接器启动时需打开根目录；literal 不授权读取其子路径。
      '(allow file-read-data (literal "/"))',
      `(allow file-read* ${readRules} (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/urandom") (literal "/dev/null"))`,
      `(allow file-write* ${writeRules} (literal "/dev/null"))`,
      `(deny file-write* (subpath ${JSON.stringify(directory)}) (literal ${JSON.stringify(entry)}) (literal ${JSON.stringify(node)}))`,
      protectedRule,
    ].join('\n')
    return { executable: '/usr/bin/sandbox-exec', args: ['-p', profile, node, ...nodeArgs], env }
  }
  throw new Error(`unsupported-runtime: 当前平台没有受限插件沙箱：${process.platform}`)
}
