import { app, Menu, nativeImage, powerMonitor, shell, systemPreferences, Tray, type BrowserWindow } from 'electron'
import { mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { computerOperations, type ComputerState, type ComputerReply } from '@pi-meme/contracts/computer-use'
import { validateReadArguments, SystemReadError } from '@pi-meme/contracts/system-read'
import type { SystemClientRequest } from '@pi-meme/contracts/system-tools'
import { operate, resolveApp, type ComputerTargets } from './native'

type Grant = ComputerState['grants'][number]
type Settings = Pick<ComputerState, 'enabled' | 'grants'>
type Decision = 'once' | 'always' | 'deny'
type Ticket = { request: SystemClientRequest; target: Awaited<ReturnType<typeof resolveApp>>; remember: boolean }
type Run = {
  activity: NonNullable<ComputerState['active']>
  registration: string
  directory: string
  controller: AbortController
  grants: Set<string>
  denied: Set<string>
  targets: ComputerTargets
}

export function registerComputerUse(
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => void,
  getWindow: () => BrowserWindow | null,
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return
  const file = path.join(app.getPath('userData'), 'computer-use.json')
  let run: Run | undefined
  let ticket: Ticket | undefined
  let busy = false
  let locked = false
  let tray: Tray | undefined
  let asking: { id: string; finish: (decision: Decision) => void } | undefined
  const stopped = new Map<string, string>()
  const notify = () => {
    const window = getWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('computer:changed')
  }
  function settings(): Settings {
    try {
      const value: Settings = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof value.enabled !== 'boolean' || !Array.isArray(value.grants)) throw new Error('电脑操控设置无效')
      return value
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: true, grants: [] }
      throw cause
    }
  }
  function save(value: Settings) {
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    notify()
  }
  function end(id?: string) {
    if (!run || (id && run.activity.executionId !== id)) return
    const previous = run
    run = undefined
    ticket = undefined
    previous.controller.abort()
    asking?.finish('deny')
    asking = undefined
    tray?.destroy()
    tray = undefined
    rmSync(previous.directory, { recursive: true, force: true })
    notify()
  }
  function stop(id: string) {
    if (run?.activity.executionId !== id) return
    stopped.set(id, run.registration)
    end(id)
  }
  powerMonitor.on('lock-screen', () => {
    locked = true
    if (run) stop(run.activity.executionId)
  })
  powerMonitor.on('unlock-screen', () => {
    locked = false
  })
  app.on('will-quit', () => end())
  app.on('web-contents-created', (_event, contents) => {
    const reset = () => {
      if (run && contents === getWindow()?.webContents) stop(run.activity.executionId)
    }
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) reset()
    })
    contents.on('render-process-gone', reset)
    contents.on('destroyed', reset)
  })
  const state = (): ComputerState => ({
    ...settings(),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus('screen'),
    active: run ? { ...run.activity } : undefined,
    pendingId: asking?.id,
  })
  function check(request: SystemClientRequest) {
    if (
      !request?.executionId ||
      !/^[a-f0-9]{64}$/.test(request.executionId) ||
      !request.session?.hostId ||
      !request.session.sessionId ||
      !request.registrationId
    )
      throw new SystemReadError('invalid-input', '电脑操控缺少有效的发起会话')
    if (!settings().enabled) throw new SystemReadError('disabled', '电脑操控已关闭，可在设置 → 电脑操控开启')
    if (locked || powerMonitor.getSystemIdleState(1) === 'locked')
      throw new SystemReadError('cancelled', '设备已锁定，电脑操作已停止')
    if (stopped.has(request.executionId)) throw new SystemReadError('cancelled', '用户已停止本轮电脑操作')
    if (!Number.isFinite(request.deadline) || Date.now() >= request.deadline)
      throw new SystemReadError('timeout', '电脑操作已过期')
    const op = computerOperations.find((item) => item.name === request.operation)
    if (!op || !Array.isArray(request.args)) throw new SystemReadError('not-supported', '不支持的电脑操作')
    validateReadArguments(op.inputSchema, request.args)
  }
  function ask(id: string, deadline: number): Promise<Decision> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = (value: Decision) => {
        clearTimeout(timer)
        asking = undefined
        notify()
        resolve(value)
      }
      timer = setTimeout(finish, Math.max(1, deadline - Date.now()), 'deny')
      asking = { id, finish }
      notify()
    })
  }
  async function authorize(request: SystemClientRequest) {
    check(request)
    if (
      busy ||
      (ticket && ticket.request.deadline > Date.now()) ||
      (run && run.activity.executionId !== request.executionId)
    )
      throw new SystemReadError('not-loaded', '电脑正在执行另一个操作，请稍后再试')
    ticket = undefined
    busy = true
    try {
      if (!run) {
        run = {
          activity: {
            hostId: request.session.hostId,
            sessionId: request.session.sessionId,
            executionId: request.executionId!,
            app: String(request.args[0]),
            operation: request.operation,
          },
          registration: request.registrationId,
          directory: mkdtempSync(path.join(app.getPath('temp'), 'pi-meme-computer-')),
          controller: new AbortController(),
          grants: new Set(),
          denied: new Set(),
          targets: { windows: new Map(), refs: new Map() },
        }
        tray = new Tray(nativeImage.createEmpty())
        tray.setTitle('电脑')
        tray.setToolTip('Pi meme 正在使用电脑')
        const currentId = request.executionId!
        tray.setContextMenu(Menu.buildFromTemplate([{ label: '停止电脑操作', click: () => stop(currentId) }]))
      }
      const current = run
      if (
        current.registration !== request.registrationId ||
        current.activity.hostId !== request.session.hostId ||
        current.activity.sessionId !== request.session.sessionId
      )
        throw new SystemReadError('permission-denied', '电脑操作来自其他客户端')
      const target = await resolveApp(request.args[0], current.controller.signal)
      current.controller.signal.throwIfAborted()
      current.activity = { ...current.activity, app: target.name, operation: request.operation }
      notify()
      if (current.denied.has(target.id)) throw new SystemReadError('permission-denied', '用户已拒绝本轮访问该应用')
      let remember = false
      if (
        !current.grants.has(target.id) &&
        !settings().grants.some((g) => g.hostId === request.session.hostId && g.appId === target.id)
      ) {
        const decision = await ask(request.id, request.deadline)
        current.controller.signal.throwIfAborted()
        if (decision === 'deny') {
          current.denied.add(target.id)
          throw new SystemReadError('permission-denied', '用户已拒绝或授权请求已过期')
        }
        remember = decision === 'always'
      }
      check(request)
      ticket = { request, target, remember }
    } finally {
      busy = false
    }
  }
  async function execute(request: SystemClientRequest) {
    check(request)
    const prepared = ticket
    const current = run
    if (
      !current ||
      !prepared ||
      prepared.request.id !== request.id ||
      current.activity.executionId !== request.executionId ||
      current.registration !== request.registrationId
    )
      throw new SystemReadError('cancelled', '电脑操作授权已失效')
    ticket = undefined
    busy = true
    try {
      const { target, remember, request: original } = prepared
      if (remember) {
        const value = settings()
        if (!value.grants.some((g) => g.hostId === original.session.hostId && g.appId === target.id))
          save({
            ...value,
            grants: [...value.grants, { hostId: original.session.hostId, appId: target.id, name: target.name }],
          })
      }
      current.grants.add(target.id)
      if (!systemPreferences.isTrustedAccessibilityClient(false))
        throw new SystemReadError('permission-denied', '请在设置 → 电脑操控开启 macOS 辅助功能')
      if (
        original.operation === 'computer.screenshot' &&
        systemPreferences.getMediaAccessStatus('screen') !== 'granted'
      )
        throw new SystemReadError('permission-denied', '请在设置 → 电脑操控开启 macOS 屏幕录制')
      const result = await operate(
        original.operation,
        original.args,
        target,
        current.directory,
        current.targets,
        current.controller.signal,
        original.deadline,
      )
      current.controller.signal.throwIfAborted()
      return result
    } finally {
      busy = false
    }
  }
  async function reply(work: Promise<unknown>): Promise<ComputerReply> {
    try {
      return { ok: true, result: await work }
    } catch (cause) {
      if (cause instanceof SystemReadError)
        return { ok: false, code: cause.code, message: cause.message, details: cause.details }
      if (cause instanceof Error && cause.name === 'AbortError')
        return { ok: false, code: 'cancelled', message: '电脑操作已停止' }
      return { ok: false, code: 'internal-error', message: '本机执行失败，请检查电脑操控设置后重试' }
    }
  }
  handle('computer:state', state)
  handle('computer:authorize', (r) => reply(authorize(r as SystemClientRequest)))
  handle('computer:execute', (r) => reply(execute(r as SystemClientRequest)))
  handle('computer:respond', (id, value) => {
    if (asking?.id !== id || !['once', 'always', 'deny'].includes(String(value))) throw new Error('授权请求已过期')
    asking?.finish(value as Decision)
  })
  handle('computer:stop', (id) => stop(String(id)))
  handle('computer:release', (registration, id) => {
    if (run && run.registration === registration && (!id || id === run.activity.executionId))
      end(run.activity.executionId)
    if (typeof id === 'string') {
      if (stopped.get(id) === registration) stopped.delete(id)
    } else {
      for (const [key, owner] of stopped) if (owner === registration) stopped.delete(key)
    }
  })
  handle('computer:enable', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('开关值无效')
    save({ ...settings(), enabled })
    if (!enabled && run) stop(run.activity.executionId)
  })
  handle('computer:revoke', (hostId, appId) => {
    const value = settings()
    const match = (g: Grant) => g.hostId === hostId && g.appId === appId
    save({ ...value, grants: value.grants.filter((g) => !match(g)) })
    if (run?.activity.hostId === hostId && run) stop(run.activity.executionId)
  })
  handle('computer:permission', async (kind) => {
    if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
    else if (kind !== 'screen') throw new Error('未知系统权限')
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${
        kind === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'
      }`,
    )
  })
}
