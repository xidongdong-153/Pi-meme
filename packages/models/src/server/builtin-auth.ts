import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type {
  BuiltinAuthMethod,
  BuiltinAuthType,
  BuiltinLogoutResult,
  BuiltinProviderInfo,
  ModelLoginNotice,
  ModelLoginPrompt,
  ModelLoginState,
} from '@pi-meme/contracts/model-config'
import { desktopBuiltinProviderIds, createDesktopModelRuntime } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'

type DesktopRuntime = Awaited<ReturnType<typeof createDesktopModelRuntime>>
type LoginAttempt = {
  id: string
  providerId: string
  providerName: string
  authType: BuiltinAuthType
  status: ModelLoginState['status']
  notices: ModelLoginNotice[]
  prompt?: ModelLoginPrompt
  error?: string
  reconnectError?: string
  abort: AbortController
  timedOut: boolean
  resolvePrompt?: (value: string) => void
  rejectPrompt?: (cause: Error) => void
  listeners: Set<() => void>
}

function text(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}无效`)
  return value as Record<string, unknown>
}
function clip(value: string | undefined, max = 2000) {
  return value?.slice(0, max)
}
function httpUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return url.href
  } catch {
    return undefined
  }
}
function syncFailure(cause: unknown) {
  return cause instanceof Error && cause.name === 'CredentialSynchronizationError'
}
function snapshot(attempt: LoginAttempt): ModelLoginState {
  return {
    id: attempt.id,
    providerId: attempt.providerId,
    providerName: attempt.providerName,
    authType: attempt.authType,
    status: attempt.status,
    notices: attempt.notices.map((notice) => ({ ...notice, links: notice.links?.map((link) => ({ ...link })) })),
    prompt: attempt.prompt
      ? { ...attempt.prompt, options: attempt.prompt.options?.map((option) => ({ ...option })) }
      : undefined,
    error: attempt.error,
    reconnectError: attempt.reconnectError,
  }
}
function pulse(attempt: LoginAttempt) {
  for (const listener of attempt.listeners) listener()
}
function wait(attempt: LoginAttempt, timeoutMs: number, until: () => boolean) {
  if (until()) return Promise.resolve(snapshot(attempt))
  return new Promise<ModelLoginState>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (!until() || done) return
      done = true
      clearTimeout(timer)
      attempt.listeners.delete(finish)
      resolve(snapshot(attempt))
    }
    timer = setTimeout(() => {
      if (done) return
      done = true
      attempt.listeners.delete(finish)
      resolve(snapshot(attempt))
    }, timeoutMs)
    attempt.listeners.add(finish)
    finish()
  })
}

export async function describeBuiltinProviders(runtime: DesktopRuntime): Promise<BuiltinProviderInfo[]> {
  const ids = await desktopBuiltinProviderIds()
  const providers: BuiltinProviderInfo[] = []
  for (const id of ids) {
    const provider = runtime.getProvider(id)
    if (!provider) continue
    const methods: BuiltinAuthMethod[] = []
    if (provider.auth.apiKey)
      methods.push({
        type: 'api_key',
        name: provider.auth.apiKey.name,
        interactive: typeof provider.auth.apiKey.login === 'function',
      })
    if (provider.auth.oauth)
      methods.push({
        type: 'oauth',
        name: provider.auth.oauth.name,
        subscription: provider.auth.oauth.isSubscription === true,
        interactive: typeof provider.auth.oauth.login === 'function',
      })
    if (!methods.length) continue
    const configured = runtime.hasConfiguredAuth(id)
    providers.push({
      id,
      name: provider.name,
      configured,
      authType: configured ? (runtime.isUsingOAuth(id) ? 'oauth' : 'api_key') : undefined,
      subscription: configured && runtime.isUsingSubscription(id),
      methods,
    })
  }
  return providers.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

export function createBuiltinAuth(options: {
  agentDir: string
  modelsPath: string
  credentials: SecureCredentialStorage
  reconnect?: () => Promise<string | undefined>
}) {
  let attempt: LoginAttempt | undefined
  let runtimeTask: Promise<DesktopRuntime> | undefined
  const runtime = () => {
    runtimeTask ??= loadPiSdk()
      .then((sdk) => createDesktopModelRuntime(sdk, options.agentDir, options.credentials, options.modelsPath))
      .catch((cause: unknown) => {
        runtimeTask = undefined
        throw cause
      })
    return runtimeTask
  }
  const providers = async () => describeBuiltinProviders(await runtime())
  const deviceId = async () => {
    const file = path.join(options.agentDir, 'device-id')
    const valid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    try {
      const existing = (await readFile(file, 'utf8')).trim()
      if (valid(existing)) return existing
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取登录设备标识')
    }
    const id = randomUUID()
    await mkdir(options.agentDir, { recursive: true })
    try {
      await writeFile(file, `${id}\n`, { mode: 0o600, flag: 'wx' })
      return id
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('无法创建登录设备标识')
    }
    const stored = (await readFile(file, 'utf8')).trim()
    if (!valid(stored)) throw new Error('登录设备标识无效')
    return stored
  }
  const execute = async (current: LoginAttempt) => {
    const timer = setTimeout(
      () => {
        current.timedOut = true
        current.abort.abort()
      },
      10 * 60 * 1000,
    )
    try {
      const active = await runtime()
      const installation = await deviceId()
      try {
        await active.login(
          current.providerId,
          current.authType,
          {
            signal: current.abort.signal,
            notify: (event) => {
              const notice = noticeFromEvent(event)
              if (!notice) return
              current.notices.push(notice)
              if (current.notices.length > 30) current.notices.shift()
              pulse(current)
            },
            prompt: (prompt) =>
              new Promise((resolve, reject) => {
                if (current.abort.signal.aborted) {
                  reject(new Error('Login cancelled'))
                  return
                }
                let onAbort = () => {}
                const cleanup = () => {
                  current.abort.signal.removeEventListener('abort', onAbort)
                  prompt.signal?.removeEventListener('abort', onAbort)
                  current.resolvePrompt = undefined
                  current.rejectPrompt = undefined
                }
                onAbort = () => {
                  cleanup()
                  reject(new Error('Login cancelled'))
                }
                current.abort.signal.addEventListener('abort', onAbort, { once: true })
                prompt.signal?.addEventListener('abort', onAbort, { once: true })
                current.resolvePrompt = (value) => {
                  cleanup()
                  resolve(value)
                }
                current.rejectPrompt = (cause) => {
                  cleanup()
                  reject(cause)
                }
                current.prompt = {
                  id: randomUUID(),
                  type: prompt.type,
                  message: clip(prompt.message) ?? '',
                  placeholder: prompt.type === 'select' ? undefined : clip(prompt.placeholder, 200),
                  options:
                    prompt.type === 'select'
                      ? prompt.options.map((option) => ({
                          id: option.id,
                          label: clip(option.label, 200) ?? option.id,
                          description: clip(option.description, 500),
                        }))
                      : undefined,
                }
                current.status = 'needs_input'
                pulse(current)
              }),
          },
          { getDeviceId: () => installation, agentName: 'pi-meme' },
        )
      } catch (cause) {
        if (!syncFailure(cause)) throw cause
      }
      runtimeTask = undefined
      current.prompt = undefined
      current.reconnectError = await options.reconnect?.()
      current.status = 'done'
    } catch (cause) {
      current.prompt = undefined
      current.resolvePrompt = undefined
      current.rejectPrompt = undefined
      if (current.timedOut) {
        current.status = 'error'
        current.error = '登录超时，请重试'
      } else if (current.abort.signal.aborted || (cause instanceof Error && cause.message === 'Login cancelled')) {
        current.status = 'cancelled'
        current.error = '登录已取消'
      } else {
        current.status = 'error'
        current.error = cause instanceof Error ? cause.message : String(cause)
      }
    } finally {
      clearTimeout(timer)
      pulse(current)
    }
  }
  return {
    providers,
    state: () => (attempt ? snapshot(attempt) : null),
    async start(value: unknown) {
      if (attempt && (attempt.status === 'running' || attempt.status === 'needs_input'))
        throw new Error('已有登录正在进行')
      const input = text(value, '登录参数')
      if (typeof input.providerId !== 'string' || (input.authType !== 'api_key' && input.authType !== 'oauth'))
        throw new Error('登录参数无效')
      const provider = (await providers()).find((item) => item.id === input.providerId)
      if (!provider) throw new Error('不是内置服务商')
      const method = provider.methods.find((item) => item.type === input.authType)
      if (!method) throw new Error('此服务商不支持该登录方式')
      if (!method.interactive) throw new Error('此服务商不能在应用内登录')
      const current: LoginAttempt = {
        id: randomUUID(),
        providerId: provider.id,
        providerName: provider.name,
        authType: input.authType,
        status: 'running',
        notices: [],
        abort: new AbortController(),
        timedOut: false,
        listeners: new Set(),
      }
      attempt = current
      void execute(current)
      return wait(current, 800, () => current.status !== 'running' || current.notices.length > 0)
    },
    async respond(value: unknown) {
      const input = text(value, '登录响应')
      if (!attempt || input.id !== attempt.id) throw new Error('登录已结束或不存在')
      if (typeof input.promptId !== 'string' || typeof input.value !== 'string') throw new Error('登录响应无效')
      if (!attempt.prompt || attempt.prompt.id !== input.promptId || !attempt.resolvePrompt)
        throw new Error('登录提示已变化，请按当前提示重新提交')
      if (input.value.length > 8000) throw new Error('登录响应过长')
      if (attempt.prompt.type === 'select') {
        if (!attempt.prompt.options?.some((option) => option.id === input.value))
          throw new Error('请选择列出的登录选项')
      } else if (!input.value.trim()) throw new Error('请输入内容')
      const resolve = attempt.resolvePrompt
      attempt.prompt = undefined
      attempt.status = 'running'
      resolve(input.value)
      return wait(attempt, 15000, () => attempt?.status !== 'running')
    },
    async cancel() {
      if (!attempt) return null
      if (attempt.status !== 'running' && attempt.status !== 'needs_input') return snapshot(attempt)
      attempt.abort.abort()
      attempt.rejectPrompt?.(new Error('Login cancelled'))
      return wait(attempt, 2000, () => attempt?.status !== 'running' && attempt?.status !== 'needs_input')
    },
    async logout(value: unknown): Promise<BuiltinLogoutResult> {
      if (typeof value !== 'string' || !value.trim()) throw new Error('服务商 ID 无效')
      if (attempt && (attempt.status === 'running' || attempt.status === 'needs_input'))
        throw new Error('请先完成或取消正在进行的登录')
      if (!(await desktopBuiltinProviderIds()).has(value)) throw new Error('不是内置服务商')
      const active = await runtime()
      try {
        await active.logout(value, { signal: AbortSignal.timeout(15000) })
      } catch (cause) {
        if (!syncFailure(cause))
          throw new Error(`退出登录失败：${cause instanceof Error ? cause.message : String(cause)}`)
      }
      runtimeTask = undefined
      return { providers: await providers(), reconnectError: await options.reconnect?.() }
    },
  }
}

function noticeFromEvent(event: {
  type: string
  message?: string
  url?: string
  instructions?: string
  links?: readonly { url: string; label?: string }[]
  userCode?: string
  verificationUri?: string
}): ModelLoginNotice | undefined {
  if (event.type === 'info')
    return {
      type: 'info',
      message: clip(event.message),
      links: event.links?.flatMap((link) => {
        const url = httpUrl(link.url)
        return url ? [{ url, label: clip(link.label, 200) }] : []
      }),
    }
  if (event.type === 'auth_url') {
    const url = httpUrl(event.url)
    return url
      ? { type: 'auth_url', url, instructions: clip(event.instructions) }
      : { type: 'progress', message: '登录地址无效' }
  }
  if (event.type === 'device_code') {
    const verificationUri = httpUrl(event.verificationUri)
    return {
      type: 'device_code',
      userCode: clip(event.userCode, 128),
      verificationUri,
      message: verificationUri ? '在浏览器中输入设备码完成登录' : '设备码已生成，但验证地址无效',
    }
  }
  if (event.type === 'progress') return { type: 'progress', message: clip(event.message) }
  return undefined
}
