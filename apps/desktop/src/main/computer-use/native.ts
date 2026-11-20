import { app } from 'electron'
import type {
  ComputerSnapshotOptions,
  ComputerSnapshotSurface,
  ComputerWindowAction,
} from '@pi-meme/contracts/computer-use'
import { SystemReadError, type ReadErrorCode, type SystemReadErrorDetails } from '@pi-meme/contracts/system-read'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

type AppProcess = { pid: number; launched: number | null }
type TargetApp = { id: string; name: string; processes: AppProcess[] }
type WindowInfo = { id: string; title: string; pid: number; app_name?: string; is_focused?: boolean }
type TargetInstance = { appId: string; process: AppProcess; windowId?: string }
type WindowTarget = TargetInstance & { windowId: string; appName?: string }
type ControlRef = TargetInstance & {
  surface: ComputerSnapshotSurface
  name?: string
  actions: string[]
  windowAction?: ComputerWindowAction
}
export type ComputerTargets = { windows: Map<string, WindowTarget>; refs: Map<string, ControlRef> }
type Tree = {
  ref_id?: string
  role?: string
  subrole?: string
  name?: string
  description?: string
  native_id?: unknown
  available_actions?: string[]
  window_action?: ComputerWindowAction
  children?: Tree[]
}
type Snapshot = { app: string; snapshot_id: string; tree: Tree; window?: { id: string } }
type Phase = 'target' | 'focus' | 'observation' | 'action'
type NativeError = {
  code?: unknown
  message?: unknown
  details?: { kind?: unknown }
  disposition?: { delivery?: unknown; retry?: unknown }
}

const nativeCodes = new Map<string, ReadErrorCode>([
  ['APP_NOT_FOUND', 'not-found'],
  ['WINDOW_NOT_FOUND', 'not-found'],
  ['ELEMENT_NOT_FOUND', 'not-found'],
  ['AMBIGUOUS_TARGET', 'invalid-input'],
  ['STALE_REF', 'stale-cursor'],
  ['SNAPSHOT_NOT_FOUND', 'stale-cursor'],
  ['PERM_DENIED', 'permission-denied'],
  ['ACTION_NOT_SUPPORTED', 'not-supported'],
  ['POLICY_DENIED', 'not-supported'],
  ['INVALID_ARGS', 'invalid-input'],
  ['TIMEOUT', 'timeout'],
])
const windowControlRoles = new Map<string, ComputerWindowAction>([
  ['AXCloseButton', 'close'],
  ['AXMinimizeButton', 'minimize'],
  ['AXFullScreenButton', 'fullscreen'],
  ['AXZoomButton', 'zoom'],
])
// 1.3.1 将 macOS 窗口按钮投影为窗口的直接子节点，并提供标准名称。
const windowControlNames = new Map<string, ComputerWindowAction>([
  ['Close', 'close'],
  ['Minimize', 'minimize'],
  ['Full Screen', 'fullscreen'],
  ['Zoom', 'zoom'],
])
const keyCombo = /^(?:[a-z0-9]+\+)*(?:[a-z0-9]+|[,./;'[\]\\=\x60-])$/i
const selectWindowHint = '重新用 computer.windows 读取该应用的窗口并选择窗口 ID'

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
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id), processes = []
  for (let i = 0; i < apps.count; i++) {
    const instance = apps.objectAtIndex(i), date = instance.launchDate
    processes.push({pid: Number(instance.processIdentifier), launched: date ? Number(date.timeIntervalSince1970) : null})
  }
  const name = Number(apps.count) > 0 ? apps.objectAtIndex(0).localizedName.js : $.NSFileManager.defaultManager.displayNameAtPath(url.path).js
  return JSON.stringify({id, name, processes})
}`

function output(
  file: string,
  args: string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
  input?: string,
  timeout = 12_000,
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', signal, timeout, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024, env },
      (err, stdout) => {
        if (signal.aborted) return reject(new SystemReadError('cancelled', '电脑操作已停止'))
        if (err && !stdout.trim()) return reject(err)
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

function sameProcess(left: AppProcess, right: AppProcess) {
  return left.pid === right.pid && left.launched === right.launched
}

function targetError(code: ReadErrorCode, message: string, nativeCode: string, recovery = selectWindowHint) {
  return new SystemReadError(code, message, { nativeCode, phase: 'target', delivery: 'not_delivered', recovery })
}

function focusError(message: string, nativeCode: string, retry?: SystemReadErrorDetails['retry']) {
  return new SystemReadError('not-loaded', message, {
    nativeCode,
    phase: 'focus',
    reason: 'focus_verification',
    delivery: 'not_delivered',
    ...(retry ? { retry } : {}),
    recovery:
      retry === 'unsafe'
        ? '先回读界面确认当前焦点'
        : '重新确认目标窗口。任务允许切换前台时，可用 computer.press 的 focus 选项先聚焦',
  })
}

function actionError(message: string, nativeCode: string, recovery: string) {
  return new SystemReadError('not-supported', message, {
    nativeCode,
    phase: 'action',
    delivery: 'not_delivered',
    recovery,
  })
}

function nativeFailure(error: NativeError | undefined, phase: Phase) {
  const nativeCode = typeof error?.code === 'string' ? error.code.slice(0, 100) : 'INTERNAL'
  const message = (typeof error?.message === 'string' && error.message.trim().slice(0, 350)) || '本机操作失败'
  const reason = typeof error?.details?.kind === 'string' ? error.details.kind.slice(0, 100) : undefined
  const { delivery, retry } = error?.disposition ?? {}
  const needsFocus =
    reason === 'focus_verification' ||
    (nativeCode === 'STALE_REF' && /exact focus could not be confirmed.*no key was sent/i.test(message)) ||
    (phase === 'focus' && (nativeCode === 'ACTION_FAILED' || nativeCode === 'TIMEOUT'))
  if (needsFocus && (delivery === undefined || delivery === 'not_delivered'))
    return focusError(
      '无法确认指定窗口已聚焦，按键未发送',
      nativeCode,
      retry === 'safe' || retry === 'unsafe' ? retry : undefined,
    )

  const details: SystemReadErrorDetails = { nativeCode, phase: needsFocus ? 'focus' : phase }
  if (reason) details.reason = reason
  if (
    delivery === 'not_delivered' ||
    delivery === 'delivered_verified' ||
    delivery === 'delivered_unverified' ||
    delivery === 'delivery_uncertain'
  )
    details.delivery = delivery
  if (retry === 'safe' || retry === 'unsafe') details.retry = retry
  if (delivery === 'delivery_uncertain' || delivery === 'delivered_unverified' || retry === 'unsafe')
    details.recovery = '先回读界面确认当前状态，再决定下一步'
  else if (nativeCode === 'AMBIGUOUS_TARGET' || nativeCode === 'WINDOW_NOT_FOUND') details.recovery = selectWindowHint
  else if (nativeCode === 'STALE_REF' || nativeCode === 'SNAPSHOT_NOT_FOUND')
    details.recovery = '重新读取目标窗口或菜单，使用新返回的引用'
  else if (nativeCode === 'POLICY_DENIED' || nativeCode === 'ACTION_NOT_SUPPORTED')
    details.recovery = '使用快照中明确支持所需动作的目标，或查找应用原生菜单中的对应操作'
  return new SystemReadError(nativeCodes.get(nativeCode) ?? 'internal-error', message, details)
}

function windowAction(node: Tree, parent: Tree | undefined) {
  const action = node.subrole && windowControlRoles.get(node.subrole)
  if (action) return action
  if (node.role === 'button' && parent?.role === 'window' && !node.native_id)
    return windowControlNames.get(node.name ?? '')
}

function forgetControls(targets: ComputerTargets, appId: string, process?: AppProcess) {
  for (const [ref, control] of targets.refs) {
    if (control.appId === appId && (!process || sameProcess(control.process, process))) targets.refs.delete(ref)
  }
}

function rememberSnapshot(
  data: Snapshot,
  instance: TargetInstance,
  surface: ComputerSnapshotSurface,
  refs: ComputerTargets['refs'],
) {
  for (const [ref, control] of refs) {
    if (
      control.appId === instance.appId &&
      sameProcess(control.process, instance.process) &&
      control.windowId === instance.windowId &&
      control.surface === surface
    )
      refs.delete(ref)
  }
  const nodes: { node: Tree; parent?: Tree }[] = [{ node: data.tree }]
  while (nodes.length) {
    const { node, parent } = nodes.pop()!
    if (node.ref_id && /^@[\w-]+:e\d+$/.test(node.ref_id)) {
      const action = windowAction(node, parent)
      if (action) node.window_action = action
      refs.set(node.ref_id, {
        ...instance,
        surface,
        name: node.name || node.description,
        actions: Array.isArray(node.available_actions) ? node.available_actions : [],
        windowAction: action,
      })
    }
    if (Array.isArray(node.children)) for (const child of node.children) nodes.push({ node: child, parent: node })
  }
  while (refs.size > 16_384) refs.delete(refs.keys().next().value!)
}

export async function operate(
  operation: string,
  args: unknown[],
  target: TargetApp,
  directory: string,
  targets: ComputerTargets,
  signal: AbortSignal,
  deadline: number,
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

  const command = async <T>(argv: string[], phase: Phase, input?: string, timeout = 12_000): Promise<T> => {
    signal.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new SystemReadError('timeout', '电脑操作已过期', { phase, delivery: 'not_delivered' })
    let response: { ok: true; data: T } | { ok: false; error?: NativeError }
    try {
      response = JSON.parse(await output(cli, argv, signal, env, input, Math.min(remaining, timeout)))
    } catch (cause) {
      if (cause instanceof SystemReadError) throw cause
      const details: SystemReadErrorDetails = { phase }
      if (phase === 'action' || phase === 'focus') {
        details.delivery = 'delivery_uncertain'
        details.retry = 'unsafe'
        details.recovery = '先回读界面确认当前状态'
      }
      throw new SystemReadError(
        Date.now() >= deadline ? 'timeout' : 'internal-error',
        '原生电脑工具未返回可读取的结果',
        details,
      )
    }
    if (response.ok !== true) throw nativeFailure(response.error, phase)
    return response.data
  }

  // 原生命令使用窗口 ID。应用归属先按实际进程核验，不能用显示名重选应用。
  const listWindows = async () => {
    const windows = await command<WindowInfo[]>(['list-windows', '--app', target.id], 'target')
    return windows.flatMap((window) => {
      const owner = target.processes.find((instance) => instance.pid === window.pid)
      return owner ? [{ ...window, owner }] : []
    })
  }
  const selectWindow = async (id?: string): Promise<WindowTarget> => {
    const windows = await listWindows()
    if (!id && windows.length > 1)
      throw targetError('invalid-input', '该应用有多个窗口，请指定窗口 ID', 'AMBIGUOUS_TARGET')
    const window = id ? windows.find((item) => item.id === id) : windows[0]
    if (!window) throw targetError('not-found', '该应用的目标窗口不存在或已关闭', 'WINDOW_NOT_FOUND')
    const previous = targets.windows.get(window.id)
    if (previous && (previous.appId !== target.id || !sameProcess(previous.process, window.owner)))
      throw targetError('stale-cursor', '目标窗口已变更所属进程', 'STALE_REF')
    const instance = { appId: target.id, process: window.owner, windowId: window.id, appName: window.app_name }
    targets.windows.set(window.id, instance)
    return instance
  }
  const assertTarget = async (instance: TargetInstance, requireFocus = false) => {
    const current = await resolveApp(instance.appId, signal)
    if (current.id !== instance.appId || !current.processes.some((owner) => sameProcess(owner, instance.process)))
      throw targetError('stale-cursor', '目标应用已退出或重新启动', 'STALE_REF')
    if (instance.windowId) {
      const window = (await listWindows()).find(
        (item) => item.id === instance.windowId && sameProcess(item.owner, instance.process),
      )
      if (!window) throw targetError('not-found', '目标窗口已关闭或变更', 'WINDOW_NOT_FOUND')
      if (requireFocus && window.is_focused !== true) throw focusError('目标窗口焦点已变化，按键未发送', 'STALE_REF')
    }
    return current
  }

  if (operation === 'computer.launch') {
    const activate = (args[1] as { activate?: boolean } | undefined)?.activate === true
    forgetControls(targets, target.id)
    return command(
      ['launch', target.id, ...(activate ? ['--activate'] : [])],
      'action',
      undefined,
      activate ? 30_000 : undefined,
    )
  }
  if (operation === 'computer.windows') {
    const windows = await listWindows()
    for (const window of windows)
      targets.windows.set(window.id, { appId: target.id, process: window.owner, windowId: window.id })
    return windows.map(({ id, title }) => ({ id, title }))
  }
  if (operation === 'computer.click' || operation === 'computer.setValue') {
    const ref = String(args[1])
    const control = targets.refs.get(ref)
    if (!control || control.appId !== target.id)
      throw targetError('stale-cursor', '控件引用已失效或不属于本轮应用', 'STALE_REF', '重新读取当前窗口或菜单')
    if (operation === 'computer.click') {
      const requested = args[2] as { windowAction: ComputerWindowAction; windowId: string } | undefined
      if (
        (control.windowAction || requested) &&
        (!control.windowAction ||
          requested?.windowAction !== control.windowAction ||
          requested.windowId !== control.windowId)
      )
        throw actionError(
          '窗口管理动作必须匹配控件的 windowAction 和窗口 ID',
          'POLICY_DENIED',
          '打开应用设置请读取原生菜单。用户要求管理窗口时再明确提供 windowAction',
        )
      if (!control.actions.includes('Click') || !control.name?.trim())
        throw actionError('该控件缺少明确名称或不支持语义点击', 'ACTION_NOT_SUPPORTED', '改选明确支持 Click 的目标')
    }
    await assertTarget(control)
    forgetControls(targets, control.appId, control.process)
    const result = await (operation === 'computer.click'
      ? command<Record<string, unknown>>(['click', ref], 'action')
      : command<Record<string, unknown>>(['set-value', ref, '--stdin'], 'action', String(args[2])))
    return { ...result, resolvedTarget: { name: control.name, surface: control.surface, windowId: control.windowId } }
  }
  if (operation === 'computer.press') {
    const key = args[2]
    if (typeof key !== 'string' || !keyCombo.test(key))
      throw new SystemReadError('invalid-input', '按键组合无效，可使用 cmd+, 或 cmd+comma 等组合')
    const instance = await selectWindow(String(args[1]))
    const scope = ['--window-id', instance.windowId]
    await assertTarget(instance)
    forgetControls(targets, instance.appId, instance.process)
    if ((args[3] as { focus?: boolean } | undefined)?.focus === true) {
      await command(['focus-window', ...scope], 'focus')
      await assertTarget(instance, true)
    }
    return command(['press', key, ...scope], 'action')
  }
  if (operation === 'computer.screenshot') {
    const instance = await selectWindow(String(args[1]))
    const result = await command<{ format?: unknown; data?: unknown }>(
      ['screenshot', '--window-id', instance.windowId],
      'observation',
    )
    await assertTarget(instance)
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
  const input = args[1] as string | ComputerSnapshotOptions | undefined
  const { surface, windowId } = typeof input === 'object' ? input : { surface: 'window' as const, windowId: input }
  const appOwned = surface === 'menu' || surface === 'menubar'
  const window = !appOwned || windowId ? await selectWindow(windowId) : undefined
  const owner = window?.process ?? (target.processes.length === 1 ? target.processes[0] : undefined)
  if (!owner) {
    if (target.processes.length > 1)
      throw targetError('invalid-input', '有多个应用实例，请指定一个窗口来选择原生菜单', 'AMBIGUOUS_TARGET')
    throw targetError('not-found', '目标应用未运行', 'APP_NOT_FOUND', '先使用 computer.launch 打开应用')
  }
  const scope = window ? ['--window-id', window.windowId] : ['--app', target.id]
  const data = await command<Snapshot>(['snapshot', ...scope, '--surface', surface, '--compact'], 'observation')
  const instance = { appId: target.id, process: owner, windowId: appOwned ? undefined : window?.windowId }
  const observedApp = typeof data.app === 'string' ? data.app.replace(/\.app$/i, '') : undefined
  const expectedApps = [target.name, target.id, window?.appName?.replace(/\.app$/i, '')]
  if (
    (appOwned && (!observedApp || !expectedApps.includes(observedApp))) ||
    (!appOwned && data.window?.id !== window?.windowId)
  )
    throw targetError('stale-cursor', '快照的应用或窗口与请求的目标不一致', 'STALE_REF')
  if (!data.tree || typeof data.snapshot_id !== 'string')
    throw new SystemReadError('internal-error', '原生工具未返回有效的界面快照')
  const current = await assertTarget(window ?? instance)
  if (!window && current.processes.length !== 1)
    throw targetError('invalid-input', '读取菜单时出现多个应用实例', 'AMBIGUOUS_TARGET')
  rememberSnapshot(data, instance, surface, targets.refs)
  return { ...data, surface }
}
