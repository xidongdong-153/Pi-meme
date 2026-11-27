import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storageLayoutRelativePaths as layout } from '@pi-meme/contracts/storage-paths'

export function privateHostPaths(root: string) {
  return {
    directories: [
      layout.credentialsDirectory,
      layout.agentDirectory,
      layout.workspacesConfigDirectory,
      layout.backupsDirectory,
      'pi',
      'secure',
    ].map((directory) => path.join(root, directory)),
    files: [layout.mcpLogFile, `${layout.mcpLogFile}.1`, 'auth.json', 'auth.json.tmp'].map((file) =>
      path.join(root, file),
    ),
  }
}

export function isWithin(directory: string, file: string) {
  const relative = path.relative(directory, file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function assertPublicHostPath(root: string, file: string, recursive = false) {
  const { directories, files } = privateHostPaths(root)
  if (
    directories.some((directory) => isWithin(directory, file)) ||
    files.some((privateFile) => path.relative(privateFile, file) === '') ||
    (recursive && [...directories, ...files].some((privatePath) => isWithin(file, privatePath)))
  )
    throw new Error('应用私有配置和凭据不能通过文件工具访问')
}

export function agentFilePath(input: string, cwd: string) {
  let file = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
  if (process.platform === 'win32')
    file = file.replace(
      /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_, drive: string, rest = '') => `${drive}:/${rest}`,
    )
  if (file === '~') return homedir()
  if (file.startsWith('~/') || (process.platform === 'win32' && file.startsWith('~\\')))
    return path.join(homedir(), file.slice(2))
  if (file.startsWith('file://')) return fileURLToPath(file)
  return path.resolve(cwd, file)
}

export async function assertPublicAgentFile(root: string, file: string, recursive = false) {
  assertPublicHostPath(root, file, recursive)
  let current = file
  const missing: string[] = []
  for (;;) {
    try {
      const resolved = await realpath(current)
      assertPublicHostPath(root, path.join(resolved, ...missing), recursive)
      return
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw cause
      missing.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
}
