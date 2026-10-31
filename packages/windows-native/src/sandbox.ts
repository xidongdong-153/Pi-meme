import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { queryWindowsNative } from './runtime'

export async function requireWindowsSandbox() {
  await queryWindowsNative('sandbox-probe')
}

/** 子进程不继承 Host 的凭据、代理或 Node 注入变量。 */
export function windowsSandboxEnvironment(temporary: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = new Map(Object.entries({ ...process.env, ...env }).map(([key, value]) => [key.toUpperCase(), value]))
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const result: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: path.parse(systemRoot).root.replace(/[\\/]$/, ''),
    HOME: temporary,
    USERPROFILE: temporary,
    LOCALAPPDATA: temporary,
    APPDATA: temporary,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(temporary, '.gitconfig'),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  }
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'PSMODULEPATH']) {
    const value = source.get(key)
    if (value !== undefined) result[key] = value
  }
  return result
}

export async function windowsRuntimeReadPaths(executable: string) {
  return Promise.all(
    [process.env.SystemRoot || 'C:\\Windows', path.dirname(executable)].map((entry) => realpath(entry)),
  )
}
