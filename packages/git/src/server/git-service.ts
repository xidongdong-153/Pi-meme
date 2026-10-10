import { spawn } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { GitEnvironment, GitFileChange, GitSnapshot } from '@pi-meme/contracts/desktop'

const outputLimit = 8 * 1024 * 1024
const untrackedPreviewLimit = 200 * 1024

export function runGit(cwd: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > outputLimit) {
        child.kill('SIGTERM')
        reject(new Error('Git 输出超过 8 MiB'))
      } else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
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

export async function getGitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim()
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
  if (kind === 'untracked') {
    const root = await realpath(snapshot.root)
    const target = path.resolve(root, filePath)
    const relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件路径无效')
    const actual = await realpath(target)
    const actualRelative = path.relative(root, actual)
    if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw new Error('不支持仓库外部链接文件')
    const info = await lstat(actual)
    if (!info.isFile()) return '不支持预览非普通文件'
    if (info.size > untrackedPreviewLimit) return `文件超过 ${untrackedPreviewLimit / 1024} KiB，未在面板中预览。`
    const data = await readFile(actual)
    if (data.includes(0)) return '二进制文件，不提供文本预览。'
    return data.toString('utf8')
  }
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
  const worktrees = (await runGit(snapshot.root, ['worktree', 'list', '--porcelain'])).stdout
  for (const entry of worktrees.split('\n\n')) {
    const lines = entry.split('\n')
    const directory = lines.find((line) => line.startsWith('worktree '))?.slice(9)
    const branch = lines.find((line) => line.startsWith('branch '))?.slice(7)
    if (directory && branch && directory !== snapshot.root) occupied.set(branch, directory)
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
