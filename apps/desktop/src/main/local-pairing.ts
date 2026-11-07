import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Pairing = { url: string; hostId: string; token: string }
type State = { version: 1; installationId: string; pairings: Pairing[] }

/** 只由 Desktop main 持有；不把已保存令牌发送给 renderer、Worker 或环境变量。 */
export function createLocalPairingStore(directory: string) {
  const file = path.join(directory, 'local-host-pairings.json')
  let state: State | undefined
  const memory = new Map<string, string>()
  let tail: Promise<unknown> = Promise.resolve()
  const load = async () => {
    if (state) return state
    let value: unknown
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('本机配对记录无法读取，请检查 Desktop 数据目录')
      state = { version: 1, installationId: randomUUID(), pairings: [] }
      return state
    }
    const input = value as State
    if (
      input?.version !== 1 ||
      !/^[\w-]{16,128}$/.test(input.installationId) ||
      !Array.isArray(input.pairings) ||
      input.pairings.some(
        (item) =>
          !item || typeof item.url !== 'string' || typeof item.hostId !== 'string' || typeof item.token !== 'string',
      )
    )
      throw new Error('本机配对记录格式无效，未使用旧凭据')
    state = input
    return input
  }
  const persist = async (next: State) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
    state = next
  }
  const serial = <T>(work: () => Promise<T>) => {
    const pending = tail.then(work)
    tail = pending.catch(() => {})
    return pending
  }
  const secure = () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  return {
    installationId: () =>
      serial(async () => {
        const current = await load()
        await persist(current)
        return current.installationId
      }),
    token: (url: string, hostId: string) =>
      serial(async () => {
        const key = JSON.stringify([url, hostId])
        if (memory.has(key)) return memory.get(key)
        const entry = (await load()).pairings.find((item) => item.url === url && item.hostId === hostId)
        if (!entry) return undefined
        if (!secure()) throw new Error('系统安全存储不可用，请重新输入令牌并取消保存配对')
        try {
          return safeStorage.decryptString(Buffer.from(entry.token, 'base64'))
        } catch {
          throw new Error('已保存配对无法解密，请重新输入访问令牌')
        }
      }),
    save: (url: string, hostId: string, token: string, remember: boolean) =>
      serial(async () => {
        const current = await load()
        if (remember && !secure()) throw new Error('系统安全存储不可用，请取消“保存配对”后连接')
        const next = {
          ...current,
          pairings: current.pairings.filter((item) => item.url !== url),
        }
        if (remember) next.pairings.push({ url, hostId, token: safeStorage.encryptString(token).toString('base64') })
        await persist(next)
        memory.set(JSON.stringify([url, hostId]), token)
      }),
  }
}
