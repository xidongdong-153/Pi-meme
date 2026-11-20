import { app } from 'electron'
import { SystemReadError, type ReadErrorCode } from '@pi-meme/contracts/system-read'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

type TargetApp = { id: string; name: string; pids: number[] }
type WindowInfo = { id: string; title: string; pid: number; app_name: string }
type Tree = { ref_id?: string; children?: Tree[] }

// LaunchServices 只解析本机应用身份。名称通过 argv 传入，不拼接脚本。
const lookup = `ObjC.import('AppKit')
function run(args) {
  const ws = $.NSWorkspace.sharedWorkspace, key = args[0]
  let url = ws.URLForApplicationWithBundleIdentifier(key)
  if (!url.path || !url.path.js) {
    const found = ws.fullPathForApplication(key)
    if (found && found.js) {
      url = $.NSURL.fileURLWithPath(found)
    } else {
      const fm = $.NSFileManager.defaultManager, matches = []
      const directories = ['/System/Applications', '/Applications', '/System/Applications/Utilities', '/Applications/Utilities', $.NSHomeDirectory().js + '/Applications']
      for (const dir of directories) {
        const entries = fm.contentsOfDirectoryAtPathError(dir, null)
        for (let i = 0; i < Number(entries.count); i++) {
          const file = entries.objectAtIndex(i).js
          if (!file.endsWith('.app')) continue
          const path = dir + '/' + file, name = fm.displayNameAtPath(path).js
          if (name === key || (name.endsWith('.app') && name.slice(0, -4) === key)) matches.push(path)
        }
      }
      if (matches.length !== 1) return 'null'
      url = $.NSURL.fileURLWithPath(matches[0])
    }
  }
  const id = $.NSBundle.bundleWithURL(url).bundleIdentifier.js
  if (!id) return 'null'
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id), pids = []
  for (let i = 0; i < apps.count; i++) pids.push(Number(apps.objectAtIndex(i).processIdentifier))
  const name = Number(apps.count) > 0 ? apps.objectAtIndex(0).localizedName.js : $.NSFileManager.defaultManager.displayNameAtPath(url.path).js
  return JSON.stringify({id, name, pids})
}`

function output(file: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv, input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', signal, timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024, env },
      (err, stdout) => {
        if (signal.aborted) return reject(new SystemReadError('cancelled', '电脑操作已停止'))
        if (err && !stdout.trim()) return reject(new Error('本机程序执行失败或超时，请检查电脑操控权限'))
        resolve(stdout)
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

export async function resolveApp(name: unknown, signal: AbortSignal): Promise<TargetApp> {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 180 ||
    /[/\\\p{Cc}\p{Cf}]/u.test(name) ||
    name.startsWith('-')
  )
    throw new SystemReadError('invalid-input', '请指定本机应用名称或 bundle ID')
  const result = JSON.parse(
    await output('/usr/bin/osascript', ['-l', 'JavaScript', '-e', lookup, '--', name], signal),
  ) as TargetApp | null
  if (!result || !/^[\w-]+(?:\.[\w-]+)+$/.test(result.id) || !result.name)
    throw new SystemReadError('not-found', '找不到指定的本机应用')
  return { ...result, name: result.name.replace(/\.app$/i, '') }
}

export async function operate(
  operation: string,
  args: unknown[],
  target: TargetApp,
  directory: string,
  refs: Map<string, string>,
  signal: AbortSignal,
) {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime/bin')
    : path.join(
        path.dirname(createRequire(path.join(app.getAppPath(), 'package.json')).resolve('agent-desktop/package.json')),
        'bin',
      )
  const suffix = '-darwin-arm64'
  const cli = path.join(dir, `agent-desktop${suffix}`)
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: app.getPath('home'),
    TMPDIR: app.getPath('temp'),
    AGENT_DESKTOP_HOME: directory,
    AGENT_DESKTOP_MACOS_HELPER_PATH: path.join(dir, `agent-desktop-macos-helper${suffix}`),
  }
  const command = async (argv: string[], input?: string) => {
    signal.throwIfAborted()
    const response = JSON.parse(await output(cli, argv, signal, env, input))
    if (response.ok !== true) {
      const code = String(response.error?.code ?? '')
      const codes: Record<string, ReadErrorCode> = {
        APP_NOT_FOUND: 'not-found',
        WINDOW_NOT_FOUND: 'not-found',
        ELEMENT_NOT_FOUND: 'not-found',
        STALE_REF: 'stale-cursor',
        PERM_DENIED: 'permission-denied',
        ACTION_NOT_SUPPORTED: 'not-supported',
        INVALID_ARGS: 'invalid-input',
        TIMEOUT: 'timeout',
      }
      throw new SystemReadError(
        codes[code] ?? 'internal-error',
        `${code} · ${String(response.error?.message ?? '请重新读取窗口').slice(0, 350)}`,
      )
    }
    return response.data
  }
  if (operation === 'computer.launch') return command(['launch', target.id])
  if (operation === 'computer.click' || operation === 'computer.setValue') {
    const ref = args[1]
    if (typeof ref !== 'string' || refs.get(ref) !== target.id)
      throw new SystemReadError('invalid-input', '控件不属于本轮该应用的快照，请重新读取')
    return operation === 'computer.click'
      ? command(['click', ref])
      : command(['set-value', ref, '--stdin'], String(args[2]))
  }
  // 窗口 ID 是机器范围资源，不能只信任调用方提供的应用名称。
  const windows = ((await command(['list-windows', '--app', target.id])) as WindowInfo[]).filter((w) =>
    target.pids.includes(w.pid),
  )
  if (operation === 'computer.windows') return windows.map(({ id, title }) => ({ id, title }))
  const window = args[1] === undefined && windows.length === 1 ? windows[0] : windows.find((w) => w.id === args[1])
  if (!window) throw new SystemReadError('not-found', '请先用 computer.windows 选择该应用的一个可用窗口')
  const scope = ['--app', window.app_name, '--window-id', window.id]
  if (operation === 'computer.press') {
    const key = args[2]
    if (typeof key !== 'string' || !/^[a-z0-9]+(?:\+[a-z0-9]+)*$/i.test(key))
      throw new SystemReadError('invalid-input', '按键组合无效')
    return command(['press', key, ...scope])
  }
  if (operation === 'computer.screenshot') {
    const result = await command(['screenshot', ...scope])
    if (
      result.format !== 'png' ||
      typeof result.data !== 'string' ||
      !result.data.length ||
      Buffer.byteLength(result.data, 'base64') > 8 * 1024 * 1024
    )
      throw new SystemReadError('invalid-input', '窗口截图过大或无效')
    return { type: 'image', mimeType: 'image/png', data: result.data }
  }
  if (operation !== 'computer.snapshot') throw new SystemReadError('not-supported', '未知的电脑操作')
  const data = await command(['snapshot', ...scope, '--compact'])
  const nodes: Tree[] = data.tree ? [data.tree] : []
  while (nodes.length) {
    const node = nodes.pop()!
    if (node.ref_id && /^@[\w-]+:e\d+$/.test(node.ref_id)) refs.set(node.ref_id, target.id)
    if (Array.isArray(node.children)) nodes.push(...node.children)
  }
  while (refs.size > 16384) {
    const oldest = refs.keys().next()
    if (oldest.done) break
    refs.delete(oldest.value)
  }
  return data
}
