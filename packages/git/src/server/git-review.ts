import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  GitReviewQuery,
  GitReviewSnapshot,
  GitReviewFileContent,
  GitReviewOptions,
  GitReviewFile,
} from '@pi-meme/contracts/git-review'
import { getGitEnvironment, runGit } from './git-service'

const previewLimit = 200 * 1024
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames']

function validateQuery(query: GitReviewQuery) {
  if (!query || !['uncommitted', 'unstaged', 'staged', 'commit', 'branch'].includes(query.scope))
    throw new Error('变更范围无效')
  if (
    (query.scope === 'commit' || query.scope === 'branch') &&
    (typeof query.ref !== 'string' || !query.ref || query.ref.startsWith('-') || query.ref.includes('\0'))
  )
    throw new Error('请选择有效的比较对象')
}

async function comparison(cwd: string, query: GitReviewQuery) {
  validateQuery(query)
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim()
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
    .then((r) => r.stdout.trim())
    .catch(() => emptyTree)
  let before = query.scope === 'unstaged' ? ':' : head
  let after = query.scope === 'staged' ? ':' : ''
  if (query.scope === 'commit') {
    if (!/^[a-f0-9]{7,64}$/i.test(query.ref!)) throw new Error('提交编号无效')
    after = (await runGit(root, ['rev-parse', '--verify', `${query.ref}^{commit}`])).stdout.trim()
    const parents = (await runGit(root, ['rev-list', '--parents', '-n', '1', after])).stdout.trim().split(' ')
    before = parents[1] ?? emptyTree
  } else if (query.scope === 'branch') {
    const refs = (
      await runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'])
    ).stdout.split('\n')
    if (!refs.includes(query.ref!)) throw new Error('比较分支已不存在，请重新选择')
    if (head === emptyTree) throw new Error('仓库尚无提交，不能比较分支')
    before = (await runGit(root, ['merge-base', head, query.ref!])).stdout.trim()
    after = head
  }
  const revisions = after === ':' ? ['--cached', before] : before === ':' ? [] : after ? [before, after] : [before]
  return { root, before, after, revisions }
}

async function currentFile(root: string, file: string): Promise<{ text?: string; notice?: string; exists: boolean }> {
  const target = path.resolve(root, file)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('文件路径无效')
  const info = await lstat(target).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null
    throw cause
  })
  if (!info) return { text: '', exists: false }
  const actual = await realpath(target)
  const actualRelative = path.relative(await realpath(root), actual)
  if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative))
    return { exists: false, notice: '不支持预览仓库外部链接文件' }
  if (!info.isFile()) return { exists: false, notice: '不支持预览非普通文件' }
  if (info.size > previewLimit) return { exists: true, notice: '文件超过 200 KiB，未在面板中预览。' }
  const data = await readFile(target)
  return data.includes(0)
    ? { exists: true, notice: '二进制文件，不提供文本预览。' }
    : { exists: true, text: data.toString('utf8') }
}

async function versionFile(root: string, revision: string, file: string) {
  if (!revision) return currentFile(root, file)
  if (revision === emptyTree) return { text: '', exists: false }
  const spec = revision === ':' ? `:${file}` : `${revision}:${file}`
  const size = await runGit(root, ['cat-file', '-s', spec])
    .then((r) => Number(r.stdout.trim()))
    .catch(() => null)
  if (size === null) return { text: '', exists: false }
  if (size > previewLimit) return { exists: true, notice: '文件超过 200 KiB，未在面板中预览。' }
  const data = (await runGit(root, ['cat-file', 'blob', spec])).stdout
  return data.includes('\0') ? { exists: true, notice: '二进制文件，不提供文本预览。' } : { exists: true, text: data }
}

function addedPatch(file: string, text: string) {
  const lines = text ? text.replace(/\n$/, '').split('\n') : []
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n` : ''}`
}

export async function getGitReview(cwd: string, query: GitReviewQuery): Promise<GitReviewSnapshot> {
  validateQuery(query)
  const repository = await runGit(cwd, ['rev-parse', '--show-toplevel']).catch((cause: unknown) => {
    const error = cause as { code?: string | number; message?: string }
    if (error.code === 'ENOENT') return 'unavailable' as const
    if (error.code === 128 && error.message?.includes('not a git repository')) return 'not-repository' as const
    throw cause
  })
  if (typeof repository === 'string')
    return { cwd, root: cwd, files: [], insertions: 0, deletions: 0, error: repository }
  const { root, revisions } = await comparison(cwd, query)
  const [names, stats, untracked, branch] = await Promise.all([
    runGit(root, ['diff', ...diffFlags, '--name-status', '-z', ...revisions, '--']),
    runGit(root, ['diff', ...diffFlags, '--numstat', '-z', ...revisions, '--']),
    query.scope === 'uncommitted' || query.scope === 'unstaged'
      ? runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
      : Promise.resolve({ stdout: '' }),
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      .then((r) => r.stdout.trim())
      .catch(() => '分离 HEAD'),
  ])
  const files: GitReviewFile[] = []
  const fields = names.stdout.split('\0')
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!
    const first = fields[i++]!
    const renamed = status.startsWith('R') || status.startsWith('C')
    const filePath = renamed ? fields[i++]! : first
    files.push({
      path: filePath,
      ...(renamed ? { oldPath: first } : {}),
      status: status[0]!,
      insertions: 0,
      deletions: 0,
      canOpen: false,
    })
  }
  const byPath = new Map(files.map((file) => [file.path, file]))
  const statFields = stats.stdout.split('\0')
  for (let i = 0; i < statFields.length - 1; i++) {
    const value = statFields[i]!
    const first = value.indexOf('\t')
    const second = value.indexOf('\t', first + 1)
    let filePath = value.slice(second + 1)
    if (!filePath) {
      i++
      filePath = statFields[++i]!
    }
    const file = byPath.get(filePath)
    if (file) {
      file.insertions = value.slice(0, first) === '-' ? null : Number(value.slice(0, first))
      file.deletions = value.slice(first + 1, second) === '-' ? null : Number(value.slice(first + 1, second))
    }
  }
  for (const filePath of untracked.stdout.split('\0').filter(Boolean)) {
    const content = await currentFile(root, filePath)
    const count =
      content.text === undefined ? null : content.text ? content.text.replace(/\n$/, '').split('\n').length : 0
    files.push({
      path: filePath,
      status: '?',
      insertions: count,
      deletions: count === null ? null : 0,
      canOpen: content.exists,
    })
  }
  for (const file of files) {
    if (file.status === '?') continue
    const target = path.resolve(root, file.path)
    const info = await lstat(target).catch(() => null)
    file.canOpen = info?.isFile() ?? false
  }
  return {
    cwd,
    root,
    branch,
    files,
    insertions: files.reduce((sum, file) => sum + (file.insertions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }
}

export async function getGitReviewFile(
  cwd: string,
  input: { query: GitReviewQuery; path: string },
): Promise<GitReviewFileContent> {
  if (!input || typeof input.path !== 'string' || input.path.includes('\0')) throw new Error('文件路径无效')
  const snapshot = await getGitReview(cwd, input.query)
  const file = snapshot.files.find((item) => item.path === input.path)
  if (!file) throw new Error('文件已不在变更列表中，请刷新')
  const { root, before, after, revisions } = await comparison(cwd, input.query)
  const [oldContent, newContent] = await Promise.all([
    file.status === '?' || file.status === 'A'
      ? Promise.resolve({ text: '', exists: false, notice: undefined })
      : versionFile(root, before, file.oldPath ?? file.path),
    file.status === 'D'
      ? Promise.resolve({ text: '', exists: false, notice: undefined })
      : versionFile(root, after, file.path),
  ])
  const notice = oldContent.notice ?? newContent.notice
  if (notice) return { patch: '', notice }
  const patch =
    file.status === '?'
      ? addedPatch(file.path, newContent.text ?? '')
      : (
          await runGit(root, [
            '--literal-pathspecs',
            'diff',
            ...diffFlags,
            '--unified=3',
            ...revisions,
            '--',
            ...new Set([file.oldPath ?? file.path, file.path]),
          ])
        ).stdout
  return { patch, before: oldContent.text, after: newContent.text }
}

export async function getGitReviewOptions(
  cwd: string,
  input: { search?: string; offset?: number },
): Promise<GitReviewOptions> {
  if (
    !input ||
    (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 256)) ||
    (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
  )
    throw new Error('搜索参数无效')
  const state = await getGitReview(cwd, { scope: 'staged' })
  if (state.error) return { branches: [], commits: [], hasMore: false, error: state.error }
  const environment = await getGitEnvironment(cwd)
  const [upstream, log] = await Promise.all([
    runGit(environment.root, ['rev-parse', '--symbolic-full-name', '@{upstream}'])
      .then((r) => r.stdout.trim())
      .catch(() => undefined),
    environment.headSha
      ? runGit(environment.root, [
          'log',
          '--all',
          '--format=%H%x00%s',
          '-z',
          '--max-count=51',
          `--skip=${input.offset ?? 0}`,
          ...(input.search ? ['--fixed-strings', '--regexp-ignore-case', `--grep=${input.search}`] : []),
        ])
      : Promise.resolve({ stdout: '' }),
  ])
  const fields = log.stdout.split('\0')
  const commits: GitReviewOptions['commits'] = []
  for (let i = 0; i + 1 < fields.length; i += 2)
    if (fields[i]) commits.push({ sha: fields[i]!, subject: fields[i + 1]! })
  return { branches: environment.branches, upstream, commits: commits.slice(0, 50), hasMore: commits.length > 50 }
}
