import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { create as createTar, extract as extractTar } from 'tar'
import type { SshConnectionInput } from '@pi-meme/contracts/ssh-connections'
import { SshError, sshFailure, stopChild, validateSshConnection } from './ssh-tunnels'

declare const __PI_MEME_VERSION__: string

type Target = 'macos-arm64' | 'linux-x64'
type Step = 'checking' | 'installing' | 'starting'
type Connection = Pick<SshConnectionInput, 'target' | 'port' | 'identityFile'>
export type PreparedSshHost = { port: number; hostId: string; token: string }
export type SshHostPreparer = (
  connection: Connection,
  signal: AbortSignal,
  onStep: (step: Step) => void,
) => Promise<PreparedSshHost>
type Command = (
  ssh: { executable: string; args: string[] },
  target: string,
  script: string,
  input: { file: string } | { text: string } | undefined,
  signal: AbortSignal,
) => Promise<string>
type Options = {
  cacheDirectory?: string
  version?: string
  fetch?: typeof fetch
  command?: Command
  validate?: typeof validateSshConnection
}
const maxPackageBytes = 1024 * 1024 * 1024
const maxUnpackedBytes = 3 * maxPackageBytes
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?$/i

function releaseVersion(value?: string) {
  const version = value ?? (typeof __PI_MEME_VERSION__ === 'string' ? __PI_MEME_VERSION__ : undefined)
  if (!version || !versionPattern.test(version))
    throw new SshError('host-release', '当前开发环境没有发行版本，无法自动获取远程 Host 包')
  return version
}

export function sshHostTarget(output: string): Target {
  const [system, arch, release, ...extra] = output.trim().split('\n')
  if (extra.length || !release) throw new SshError('host-platform', '无法识别 SSH 登录环境')
  if (system === 'Darwin' && arch === 'arm64' && Number(release.split('.')[0]) >= 24) return 'macos-arm64'
  if (system === 'Linux' && arch === 'x86_64') return 'linux-x64'
  throw new SshError('host-platform', '远程 Host 仅支持 macOS 15 及以上 arm64 和 Linux x64')
}

// 只发送固定脚本，动态值先限制字符集；不把 SSH 目标拼入远端命令。
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const runCommand: Command = async (ssh, target, script, input, signal) => {
  signal.throwIfAborted()
  const child = spawn(ssh.executable, [...ssh.args, '--', target, `sh -c ${quote(script)}`], {
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let stderr = ''
  let overflow = false
  let timedOut = false
  let stopping: Promise<void> | undefined
  const stop = () => (stopping ??= stopChild(child))
  const abort = () => void stop().catch(() => {})
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => {
      timedOut = true
      abort()
    },
    10 * 60 * 1000,
  )
  child.stdout.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(output) + chunk.length > 64 * 1024) {
      overflow = true
      abort()
    } else output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString()
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new SshError('ssh-unavailable', '无法启动系统 OpenSSH')))
    child.once('close', (code) => {
      if (signal.aborted) reject(signal.reason)
      else if (overflow) reject(new SshError('host-response', '远端准备响应超过限制'))
      else if (timedOut) reject(new SshError('host-timeout', '远端准备超时，请重试', true))
      else if (code !== 0) {
        const messages: Record<string, string> = {
          'host-conflict': '远端已有冲突 Host，请停止原 Host 后重试',
          'host-dependencies': '远端缺少运行依赖，请检查 Git、bash、tar 和 Linux bubblewrap',
          'host-start': '远端 Host 启动失败，请检查目录权限和运行环境',
        }
        let errorCode: unknown
        try {
          errorCode = JSON.parse(stderr).code
        } catch {
          /* 普通 SSH 诊断由 sshFailure 处理。 */
        }
        if (typeof errorCode === 'string' && Object.hasOwn(messages, errorCode))
          reject(new SshError(errorCode, messages[errorCode]))
        else if (code === 255) reject(sshFailure(stderr))
        else reject(new SshError('host-prepare', '远端准备失败，请检查运行依赖、目录权限及是否存在冲突 Host'))
      } else resolve()
    })
  })
  const written =
    input && 'file' in input
      ? pipeline(createReadStream(input.file), child.stdin, { signal })
      : new Promise<void>((resolve, reject) => {
          child.stdin.once('error', reject)
          child.stdin.end(input?.text ?? '', resolve)
        })
  try {
    const [exitResult, writeResult] = await Promise.allSettled([exited, written])
    if (exitResult.status === 'rejected') throw exitResult.reason
    if (writeResult.status === 'rejected') throw writeResult.reason
    signal.throwIfAborted()
    return output
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await stop()
  }
}

async function digest(file: string, signal: AbortSignal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function responseText(response: Response, signal: AbortSignal) {
  if (!response.ok || !response.body) throw new SshError('host-download', '当前版本的 Host 发行资源不可用')
  let text = ''
  for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
    signal.throwIfAborted()
    text += chunk.toString()
    if (Buffer.byteLength(text) > 64 * 1024) throw new SshError('host-download', 'Host 校验清单超过限制')
  }
  return text
}

export async function validateHostArchive(file: string, directory: string, version: string, target: Target) {
  let size = 0
  let invalid: SshError | undefined
  await extractTar({
    file,
    cwd: directory,
    strict: true,
    filter(name, entry) {
      if (invalid) return false
      if (!('type' in entry)) {
        invalid = new SshError('host-archive', 'Host 归档条目无效')
        return false
      }
      const normalized = path.posix.normalize(name)
      if (
        name.includes('\\') ||
        path.posix.isAbsolute(name) ||
        (normalized !== 'pi-meme-host' && !normalized.startsWith('pi-meme-host/')) ||
        !['File', 'Directory', 'SymbolicLink'].includes(entry.type)
      ) {
        invalid = new SshError('host-archive', 'Host 包含无效路径或文件类型')
        return false
      }
      size += entry.size
      if (size > maxUnpackedBytes) {
        invalid = new SshError('host-archive', 'Host 解压大小超过限制')
        return false
      }
      if (entry.type === 'SymbolicLink') {
        if (typeof entry.linkpath !== 'string') {
          invalid = new SshError('host-archive', 'Host 链接缺少目标')
          return false
        }
        const linked = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), entry.linkpath))
        if (path.posix.isAbsolute(entry.linkpath) || !linked.startsWith('pi-meme-host/')) {
          invalid = new SshError('host-archive', 'Host 包含越界链接')
          return false
        }
      }
      return true
    },
  })
  if (invalid) throw invalid
  const root = await realpath(path.join(directory, 'pi-meme-host'))
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const link = path.join(entry.parentPath, entry.name)
    const resolved = await realpath(link)
    if (path.isAbsolute(await readlink(link)) || !resolved.startsWith(`${root}${path.sep}`))
      throw new SshError('host-archive', 'Host 包含越界链接')
  }
  const metadata = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8'))
  if (
    metadata.version !== version ||
    metadata.platform !== (target === 'macos-arm64' ? 'darwin' : 'linux') ||
    metadata.arch !== (target === 'macos-arm64' ? 'arm64' : 'x64')
  )
    throw new SshError('host-archive', 'Host 包版本或平台不匹配')
  for (const name of ['runtime/bin/node', 'apps/server/dist/ssh-bootstrap.js']) {
    if (!(await lstat(path.join(root, name))).isFile()) throw new SshError('host-archive', 'Host 包缺少运行文件')
  }
}

async function downloadPackage(
  directory: string,
  version: string,
  target: Target,
  request: typeof fetch,
  signal: AbortSignal,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const asset = `pi-meme-host-${version}-${target}.tar.gz`
  const base = `https://github.com/xidongdong-153/Pi-meme/releases/download/v${version}`
  const checksums = await responseText(await request(`${base}/SHA256SUMS`, { signal }), signal)
  const checksum = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum))
    throw new SshError('host-checksum', '发行包校验清单缺少对应 Host 包')
  const cached = path.join(directory, asset)
  try {
    if ((await digest(cached, signal)) === checksum) return cached
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const temporary = await mkdtemp(path.join(directory, '.download-'))
  try {
    const response = await request(`${base}/${asset}`, { signal })
    if (!response.ok || !response.body) throw new SshError('host-download', '无法下载当前版本的 Host 包')
    const file = path.join(temporary, asset)
    const handle = await open(file, 'wx', 0o600)
    let bytes = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > maxPackageBytes ? new SshError('host-download', 'Host 下载大小超过限制') : null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      limit,
      handle.createWriteStream(),
      { signal },
    )
    if ((await digest(file, signal)) !== checksum) throw new SshError('host-checksum', 'Host 发行包 SHA256 校验失败')
    await rename(file, cached)
    return cached
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function createSshHostPreparer(options: Options = {}): SshHostPreparer {
  return async (connection, signal, onStep) => {
    onStep('checking')
    const version = releaseVersion(options.version)
    const ssh = await (options.validate ?? validateSshConnection)(connection, signal)
    const command = options.command ?? runCommand
    const probe = await command(
      ssh,
      connection.target,
      'set -eu; command -v git >/dev/null; command -v bash >/dev/null; command -v tar >/dev/null; printf "%s\\n" "$(uname -s)" "$(uname -m)" "$(uname -r)"',
      undefined,
      signal,
    )
    const target = sshHostTarget(probe)
    const relative = `.local/share/pi-meme/host/${version}/${target}`
    const install = `"$HOME/${relative}"`
    const node = `"$HOME/${relative}/runtime/bin/node"`
    const entry = `"$HOME/${relative}/apps/server/dist/ssh-bootstrap.js"`
    const exists = await command(
      ssh,
      connection.target,
      `if [ -x ${node} ] && [ -f ${entry} ]; then printf ready; else printf missing; fi`,
      undefined,
      signal,
    )
    if (exists !== 'ready' && exists !== 'missing') throw new SshError('host-response', '远端安装检查响应无效')
    if (exists === 'missing') {
      onStep('installing')
      const cache = options.cacheDirectory ?? path.join(homedir(), '.pi-meme/cache/ssh-host-packages')
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)])
      let archive: string
      try {
        archive = await downloadPackage(cache, version, target, options.fetch ?? fetch, downloadSignal)
      } catch (cause) {
        if (!signal.aborted && downloadSignal.aborted)
          throw new SshError('host-download', 'Host 下载超时，正在等待重试', true)
        throw cause
      }
      const staging = await mkdtemp(path.join(cache, '.validate-'))
      try {
        await validateHostArchive(archive, staging, version, target)
        signal.throwIfAborted()
        // 从已验证的目录重新打包，远端仅解压规范路径和内部软链接。
        const sanitized = path.join(staging, 'host.tar.gz')
        await createTar({ file: sanitized, cwd: staging, gzip: true, portable: true }, ['pi-meme-host'])
        const publish =
          'const fs=require("node:fs");try{fs.renameSync(process.argv[1],process.argv[2])}catch(e){if(!["EEXIST","ENOTEMPTY"].includes(e.code))throw e}'
        await command(
          ssh,
          connection.target,
          `set -eu; umask 077; mkdir -p "$HOME/.local/share/pi-meme/host/${version}"; stage=$(mktemp -d "$HOME/.local/share/pi-meme/host/${version}/.install.XXXXXX"); trap 'rm -rf -- "$stage"' EXIT HUP INT TERM; tar -xzf - -C "$stage"; "$stage/pi-meme-host/runtime/bin/node" -e ${quote(publish)} "$stage/pi-meme-host" ${install}`,
          { file: sanitized },
          signal,
        )
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    onStep('starting')
    const response = await command(
      ssh,
      connection.target,
      `exec ${node} ${entry}`,
      { text: JSON.stringify({ protocolVersion: 1 }) },
      signal,
    )
    let value: unknown
    try {
      value = JSON.parse(response)
    } catch {
      throw new SshError('host-response', '远端 Host 准备响应无效')
    }
    const result = value as {
      protocolVersion?: unknown
      port?: unknown
      hostId?: unknown
      token?: unknown
      version?: unknown
    }
    if (
      !result ||
      result.protocolVersion !== 1 ||
      result.version !== version ||
      typeof result.port !== 'number' ||
      !Number.isInteger(result.port) ||
      result.port < 1 ||
      result.port > 65535 ||
      typeof result.hostId !== 'string' ||
      !result.hostId ||
      result.hostId.length > 200 ||
      typeof result.token !== 'string' ||
      !result.token ||
      result.token.length > 4096
    )
      throw new SshError('host-response', '远端 Host 准备响应与当前版本不匹配')
    return { port: result.port, hostId: result.hostId, token: result.token }
  }
}
