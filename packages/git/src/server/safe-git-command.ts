import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export const gitIsolationUnavailable = 'git-safe-execution-unavailable'
function unsupported(detail: string): never {
  throw Object.assign(
    new Error(`Git 操作不受支持：${detail}。需要可禁止仓库子进程执行并隔离私有读取的后端，不会使用 Host 裸跑回退。`),
    { code: gitIsolationUnavailable },
  )
}

export function rejectGitWorktreeRead(): never {
  return unsupported('工作树正文尚无规范路径身份绑定、单链接及同 FD 有界读取')
}

/** No worktree conversion is safe here: status/diff/checkout can run arbitrarily named clean/process filters. */
export function safeGitArguments(input: string[]): string[] {
  const args = [...input]
  while (args[0]?.startsWith('-')) {
    if (args[0] === '--literal-pathspecs' || args[0] === '--no-optional-locks') args.shift()
    else if (args[0] === '-c' && args[1] === 'core.fsmonitor=false') args.splice(0, 2)
    else unsupported('未列入白名单的 Git 全局参数')
  }
  if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) unsupported('无效 Git 参数')
  const [command, ...tail] = args
  const operand = (value: string | undefined) => Boolean(value && !value.startsWith('-'))
  let allowed = false
  switch (command) {
    case 'rev-parse':
      allowed =
        (tail.length === 1 && ['--show-toplevel', '--git-common-dir'].includes(tail[0]!)) ||
        (tail.length === 2 && ['--short', '--verify', '--symbolic-full-name'].includes(tail[0]!) && operand(tail[1]))
      break
    case 'symbolic-ref':
      allowed = tail.join('\0') === '--quiet\0--short\0HEAD'
      break
    case 'for-each-ref':
      allowed =
        tail.length === 3 &&
        ['--format=%(refname)', '--format=%(refname) %(symref)'].includes(tail[0]!) &&
        tail[1] === 'refs/heads/' &&
        tail[2] === 'refs/remotes/'
      break
    case 'worktree':
      allowed = tail.join('\0') === 'list\0--porcelain\0-z'
      break
    case 'cat-file':
      allowed = tail.length === 2 && ['-s', 'blob'].includes(tail[0]!) && operand(tail[1])
      break
    case 'rev-list':
      allowed =
        tail.length === 4 &&
        tail.slice(0, 3).join('\0') === ['--parents', '-n', '1'].join('\0') &&
        /^[a-f0-9]{40,64}$/i.test(tail[3]!)
      break
    case 'merge-base':
      allowed = tail.length === 2 && tail.every(operand)
      break
    case 'ls-files':
      allowed = tail.join('\0') === '--others\0--exclude-standard\0-z'
      break
    case 'check-ref-format':
      allowed = tail.length === 2 && tail[0] === '--branch' && operand(tail[1])
      break
    case 'log':
      allowed =
        tail.length >= 5 &&
        tail.slice(0, 4).join('\0') === '--all\0--format=%H%x00%s\0-z\0--max-count=51' &&
        /^--skip=\d+$/.test(tail[4]!) &&
        (tail.length === 5 ||
          (tail.length === 8 &&
            tail[5] === '--fixed-strings' &&
            tail[6] === '--regexp-ignore-case' &&
            tail[7]!.startsWith('--grep=')))
      break
  }
  if (!allowed) unsupported(`命令 ${command ?? '(空)'} 可能读取工作树、执行过滤器或修改仓库，尚无已兑现的安全执行能力`)
  return [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '--literal-pathspecs',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.pager=cat',
    '-c',
    'diff.external=',
    '-c',
    'diff.trustExitCode=false',
    '-c',
    'log.showSignature=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'submodule.recurse=false',
    '-c',
    'fetch.recurseSubmodules=false',
    '-c',
    'core.commitGraph=false',
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
    ...args,
  ]
}

let executable: Promise<string> | undefined
export function trustedGitExecutable(): Promise<string> {
  executable ??= (async () => {
    // Windows has no POSIX ownership proof; do not infer ACL integrity from a familiar directory name.
    if (process.platform === 'win32') unsupported('尚无可核对 ACL 完整性的固定系统 Git 路径')
    if (process.getuid?.() === 0) unsupported('Host 以 root 运行，尚无只读系统二进制完整性证明')
    // /usr/bin/git on macOS can be an xcrun shim into a user-writable selected Xcode; use fixed binaries.
    const candidates =
      process.platform === 'darwin'
        ? ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git']
        : ['/usr/bin/git', '/bin/git']
    for (const candidate of candidates) {
      try {
        const actual = await realpath(candidate)
        const file = await lstat(actual)
        if (!file.isFile()) continue
        let current = actual
        for (;;) {
          const info = await lstat(current)
          if (info.uid !== 0 || (info.mode & 0o022) !== 0 || info.isSymbolicLink()) throw new Error('不可信 Git 路径')
          const parent = path.dirname(current)
          if (parent === current) break
          current = parent
        }
        // Require a modern Git that implements GIT_NO_LAZY_FETCH; protocol denial is an additional barrier.
        const version = await new Promise<string>((resolve, reject) => {
          execFile(
            actual,
            ['--version'],
            { cwd: '/', env: safeGitEnvironment(), timeout: 5000, maxBuffer: 4096, encoding: 'utf8' },
            (error, stdout) => {
              if (error) reject(error)
              else resolve(stdout)
            },
          )
        })
        const parsed = /^git version (\d+)\.(\d+)(?:\.|\s)/.exec(version)
        if (!parsed || Number(parsed[1]) !== 2 || Number(parsed[2]) < 50) continue
        return actual
      } catch {
        // Only fixed system locations are candidates; never search PATH or repository-local executables.
      }
    }
    return unsupported('未找到所有者与路径完整性可核对、支持禁止延迟获取的系统 Git 2.50+')
  })()
  return executable
}

export function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/dev/null',
    XDG_CONFIG_HOME: '/dev/null',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: '/usr/bin/false',
    GIT_SEQUENCE_EDITOR: '/usr/bin/false',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_ALLOW_PROTOCOL: '',
    GIT_EXTERNAL_DIFF: '/usr/bin/false',
  }
}
