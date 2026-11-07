import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GitEnvironment, GitFileChange, GitSnapshot } from '@pi-meme/contracts/desktop'
import type { GitWorkspaceAvailability } from '@pi-meme/contracts/git-availability'
import { executionCapabilities, type ExecutionCapabilityReport } from '@pi-meme/contracts/execution-capabilities'
import {
  gitIsolationUnavailable,
  rejectGitWorktreeRead,
  safeGitArguments,
  safeGitEnvironment,
  trustedGitExecutable,
} from './safe-git-command'

const outputLimit = 8 * 1024 * 1024

/** This report describes THIS executor, never the session Worker's unrelated sandbox. */
export function getGitExecutionCapabilityReport(): ExecutionCapabilityReport {
  return {
    backend: 'unavailable',
    platform: process.platform,
    architecture: process.arch,
    checkedAt: new Date().toISOString(),
    capabilities: Object.fromEntries(
      executionCapabilities.map((capability) => [
        capability,
        {
          status: 'unsupported',
          reason: 'Git 仅有受信系统二进制的固定元数据白名单，尚无私有读取隔离与进程树受控执行后端',
        },
      ]),
    ) as ExecutionCapabilityReport['capabilities'],
  }
}

export async function runGit(cwd: string, args: string[], limits?: { timeoutMs: number; outputBytes: number }) {
  const safeArgs = safeGitArguments(args)
  const executable = await trustedGitExecutable()
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(executable, ['-C', cwd, ...safeArgs], {
      cwd: '/',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeGitEnvironment(),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (cause: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(cause)
    }
    timer = setTimeout(() => fail(new Error('读取 Git 状态超时，请重试')), limits?.timeoutMs ?? 10_000)
    timer.unref()
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > (limits?.outputBytes ?? outputLimit)) fail(new Error('Git 输出超过读取上限，请缩小工作区后重试'))
      else chunks.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', fail)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        code: code ?? 1,
      }
      if (result.code === 0) resolve(result)
      else
        reject(
          Object.assign(new Error(`Git 操作失败：${result.stderr.trim() || '进程退出码非零'}`), { code: result.code }),
        )
    })
  })
}

function decodeStatus(output: string): GitFileChange[] {
  const fields = output.split('\0')
  const files: GitFileChange[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (status === '??') files.push({ path: filePath, status, kind: 'untracked' })
    else {
      if (status[0] !== ' ') files.push({ path: filePath, status, kind: 'staged' })
      if (status[1] !== ' ') files.push({ path: filePath, status, kind: 'unstaged' })
      if (status.includes('R') || status.includes('C')) index += 1
    }
  }
  return files
}

/** status 也可能执行工作树过滤器；无安全后端时必须返回明确错误，不能当作版本探测豁免。 */
export async function getGitWorkspaceAvailability(cwd: string): Promise<GitWorkspaceAvailability> {
  try {
    const directory = await realpath(cwd)
    const flags = ['--no-optional-locks', '-c', 'core.fsmonitor=false']
    const root = (
      await runGit(directory, [...flags, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000, outputBytes: 64 * 1024 })
    ).stdout.replace(/\r?\n$/, '')
    if (!root) throw new Error('Git 未返回工作树目录')
    const status = await runGit(root, [...flags, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
      timeoutMs: 5000,
      outputBytes: 1024 * 1024,
    })
    const files = decodeStatus(status.stdout)
    return {
      status: 'ready',
      root,
      hasStaged: files.some((file) => file.kind === 'staged'),
      hasUnstaged: files.some((file) => file.kind === 'unstaged'),
      hasUntracked: files.some((file) => file.kind === 'untracked'),
    }
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    if (error.code === 'ENOENT' && error.syscall?.startsWith('spawn'))
      return { status: 'unsupported', error: '未找到 Git' }
    if ((cause as { code?: number }).code === 128 && error.message?.includes('not a git repository'))
      return { status: 'ready', hasStaged: false, hasUnstaged: false, hasUntracked: false }
    return { status: 'error', error: error.message || '读取 Git 状态失败' }
  }
}

export async function getGitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    const root = await realpath((await runGit(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim())
    const [status, branchResult, hasHead] = await Promise.all([
      runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() =>
        runGit(root, ['rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: '未提交', stderr: '', code: 0 })),
      ),
      runGit(root, ['rev-parse', '--verify', 'HEAD'])
        .then(() => true)
        .catch(() => false),
    ])
    const stats = hasHead
      ? [
          (
            await runGit(root, [
              '--literal-pathspecs',
              'diff',
              '--numstat',
              '--no-renames',
              '--no-ext-diff',
              '--no-textconv',
              'HEAD',
              '--',
            ])
          ).stdout,
        ]
      : await Promise.all([
          runGit(root, ['diff', '--cached', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', '--']).then(
            (result) => result.stdout,
          ),
          runGit(root, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', '--']).then(
            (result) => result.stdout,
          ),
        ])
    let insertions = 0
    let deletions = 0
    for (const output of stats) {
      for (const line of output.split('\0')) {
        const firstTab = line.indexOf('\t')
        const secondTab = line.indexOf('\t', firstTab + 1)
        if (firstTab < 0 || secondTab < 0) continue
        const added = Number(line.slice(0, firstTab))
        const removed = Number(line.slice(firstTab + 1, secondTab))
        if (Number.isFinite(added)) insertions += added
        if (Number.isFinite(removed)) deletions += removed
      }
    }
    return {
      cwd,
      root,
      branch: branchResult.stdout.trim(),
      files: decodeStatus(status.stdout),
      insertions,
      deletions,
    }
  } catch (cause) {
    const code = (cause as { code?: string | number }).code
    if (code === gitIsolationUnavailable) throw cause
    return {
      cwd,
      files: [],
      insertions: 0,
      deletions: 0,
      error: code === 'ENOENT' ? 'unavailable' : code === 128 ? 'not-repository' : 'failed',
    }
  }
}

export async function getGitDiff(cwd: string, filePath: string, kind: GitFileChange['kind']) {
  const snapshot = await getGitSnapshot(cwd)
  if (!snapshot.root) throw new Error(snapshot.error === 'unavailable' ? '未找到 Git' : '当前目录不是 Git 仓库')
  if (!snapshot.files.some((file) => file.path === filePath && file.kind === kind))
    throw new Error('文件已不在变更列表中，请刷新')
  if (kind === 'untracked') return rejectGitWorktreeRead()
  const args = [
    '--literal-pathspecs',
    'diff',
    ...(kind === 'staged' ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--',
    filePath,
  ]
  return (await runGit(snapshot.root, args)).stdout
}

export async function getGitEnvironment(cwd: string): Promise<GitEnvironment> {
  const snapshot = await getGitSnapshot(cwd)
  if (!snapshot.root) throw new Error(snapshot.error === 'unavailable' ? '未找到 Git' : '当前目录不是 Git 仓库')
  const refs = await runGit(snapshot.root, [
    'for-each-ref',
    '--format=%(refname) %(symref)',
    'refs/heads/',
    'refs/remotes/',
  ])
  const occupied = new Map<string, string>()
  const worktrees = (await runGit(snapshot.root, ['worktree', 'list', '--porcelain', '-z'])).stdout
  for (const entry of worktrees.split('\0\0')) {
    const lines = entry.split('\0')
    const directory = lines.find((line) => line.startsWith('worktree '))?.slice(9)
    const branch = lines.find((line) => line.startsWith('branch '))?.slice(7)
    if (directory && branch) {
      const normalized = await realpath(directory).catch(() => path.resolve(directory))
      if (normalized !== snapshot.root) occupied.set(branch, normalized)
    }
  }
  const headSha = await runGit(snapshot.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
    .then((result) => result.stdout.trim())
    .catch(() => undefined)
  return {
    cwd,
    root: await realpath(snapshot.root),
    branch: snapshot.branch,
    headSha,
    dirty: snapshot.files.length > 0,
    branches: refs.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const [ref, symbolic] = line.split(' ')
        if (!ref || symbolic) return []
        const kind = ref.startsWith('refs/heads/') ? ('local' as const) : ('remote' as const)
        const name = ref.replace(/^refs\/(heads|remotes)\//, '')
        return [
          { ref, name, kind, occupiedBy: occupied.get(ref), current: kind === 'local' && name === snapshot.branch },
        ]
      }),
  }
}

export async function resolveGitBase(environment: GitEnvironment, baseRef: string) {
  if (!environment.headSha) throw new Error('仓库还没有提交，不能创建分支或 Worktree')
  if (baseRef === 'HEAD') return environment.headSha
  if (!environment.branches.some((branch) => branch.ref === baseRef))
    throw new Error('所选分支已不存在，请刷新分支列表')
  return (await runGit(environment.root, ['rev-parse', '--verify', `${baseRef}^{commit}`])).stdout.trim()
}

export async function switchGitBranch(
  environment: GitEnvironment,
  branchRef: string,
  newBranch?: string,
  headSha?: string,
) {
  const status = await runGit(environment.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.stdout) throw new Error('工作目录存在未提交更改，请先处理后再切换分支')
  if (newBranch !== undefined) {
    if (environment.branches.some((branch) => branch.ref === `refs/heads/${newBranch}`))
      throw new Error('分支名称已存在，请选择其他名称')
    if (!newBranch.trim() || newBranch.startsWith('-')) throw new Error('分支名称无效')
    await runGit(environment.root, ['check-ref-format', '--branch', newBranch]).catch(() => {
      throw new Error('分支名称无效')
    })
    await runGit(environment.root, ['switch', '-c', newBranch, headSha!])
  } else {
    const branch = environment.branches.find((item) => item.ref === branchRef)
    if (!branch) throw new Error('所选分支已不存在，请刷新分支列表')
    if (branch.occupiedBy) throw new Error(`此分支已被其他 Worktree 使用：${branch.occupiedBy}`)
    await runGit(
      environment.root,
      branch.kind === 'local' ? ['switch', '--', branch.name] : ['switch', '--detach', branch.ref],
    )
  }
}
