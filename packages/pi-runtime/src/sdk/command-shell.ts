import { loadPiSdk } from './load'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
let description: Promise<string> | undefined

export function windowsShellDescription(): Promise<string> {
  description ??= (async () => {
    const sdk = await loadPiSdk()
    const shell = sdk.getPowerShellConfig()
    const { stdout } = await execute(shell.shell, [...shell.args, '$PSVersionTable.PSVersion.ToString()'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    })
    const version = stdout.trim()
    if (!/^\d+\.\d+(?:\.\d+){0,2}(?:-[\w.-]+)?$/.test(version)) throw new Error('PowerShell 版本响应无效')
    return `Windows 命令工具 powershell 与 manage_service.command 使用 PowerShell ${version}，请按该版本的 PowerShell 语法生成命令。可执行文件路径含空格时使用调用运算符 &。${Number(version.split('.')[0]) < 7 ? '此版本不支持 && 和 ||，请使用分开的命令与显式退出码判断。' : ''}`
  })().catch((cause: unknown) => {
    description = undefined
    throw new Error(`无法读取 Windows PowerShell 版本：${String(cause)}`)
  })
  return description
}

/** 与 Pi 原生 PowerShell 工具共用 Shell 发现，命令内容只交给选定的 Shell。 */
export async function shellCommand(command: string) {
  if (process.platform !== 'win32') return { executable: '/bin/bash', args: ['-c', command] }
  const sdk = await loadPiSdk()
  const shell = sdk.getPowerShellConfig()
  const wrapped = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    'try {',
    '& {',
    command,
    '}',
    '$piSucceeded = $?',
    'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
    'if (-not $piSucceeded) { exit 1 }',
    '} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }',
  ].join('\n')
  return { executable: shell.shell, args: [...shell.args, wrapped] }
}
