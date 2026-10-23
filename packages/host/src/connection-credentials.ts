import type { SavedHostConnection } from '@pi-meme/contracts/host'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'

const prefix = 'remote-host:'
function origin(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('远程 Host 必须使用 HTTPS，地址不能包含凭据')
  return url.origin
}

export class ConnectionCredentialStore {
  constructor(
    private readonly credentials: SecureCredentialStorage,
    private readonly flush: () => Promise<void>,
  ) {}

  read(url: string) {
    const normalized = origin(url)
    const source = this.credentials.get(`${prefix}${normalized}`)
    if (!source) return undefined
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw new Error('已保存的远程 Host 凭据格式无效')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('token' in value) ||
      typeof value.token !== 'string' ||
      !value.token ||
      !('hostId' in value) ||
      typeof value.hostId !== 'string' ||
      !value.hostId
    )
      throw new Error('已保存的远程 Host 凭据格式无效')
    return { url: normalized, token: value.token, hostId: value.hostId }
  }
  list(): SavedHostConnection[] {
    return this.credentials.entries(prefix).map(([key]) => {
      const connection = this.read(key.slice(prefix.length))!
      return { url: connection.url, hostId: connection.hostId }
    })
  }
  async save(value: SavedHostConnection & { token: string }) {
    const url = origin(value.url)
    if (!value.token || !value.hostId) throw new Error('远程 Host 凭据不完整')
    this.credentials.set(`${prefix}${url}`, JSON.stringify({ token: value.token, hostId: value.hostId }))
    await this.flush()
  }
  private sshKey(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('SSH 连接标识无效')
    return `ssh-host:${id}`
  }
  readSsh(id: string) {
    return this.credentials.get(this.sshKey(id))
  }
  async saveSsh(id: string, token: string) {
    if (!token || token.length > 4096) throw new Error('Host 访问令牌无效')
    const key = this.sshKey(id)
    const previous = this.credentials.get(key)
    this.credentials.set(key, token)
    try {
      await this.flush()
    } catch (cause) {
      if (previous === undefined) this.credentials.delete(key)
      else this.credentials.set(key, previous)
      throw cause
    }
  }
  async removeSsh(id: string) {
    const key = this.sshKey(id)
    const previous = this.credentials.get(key)
    this.credentials.delete(key)
    try {
      await this.flush()
    } catch (cause) {
      if (previous !== undefined) this.credentials.set(key, previous)
      throw cause
    }
  }
  async remove(url: string) {
    this.credentials.delete(`${prefix}${origin(url)}`)
    await this.flush()
  }
}
