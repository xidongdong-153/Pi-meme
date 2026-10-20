import { Resolver } from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import type { PluginGrant } from '@pi-meme/plugin-sdk/permissions'
import type { PluginHttpRequest, PluginHttpResponse } from '@pi-meme/plugin-sdk/restricted'

export function publicPluginAddress(value: string) {
  try {
    const address = ipaddr.parse(value)
    if (address.range() !== 'unicast') return false
    if (address.kind() === 'ipv6') {
      const v6 = address as ipaddr.IPv6
      return (
        v6.match(ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number]) &&
        !v6.match(ipaddr.parseCIDR('2001::/23') as [ipaddr.IPv6, number])
      )
    }
    const v4 = address as ipaddr.IPv4
    return !['192.0.0.0/24', '192.88.99.0/24'].some((range) =>
      v4.match(ipaddr.parseCIDR(range) as [ipaddr.IPv4, number]),
    )
  } catch {
    return false
  }
}
export type PluginCredentialValue = { origin: string; header: 'Authorization' | 'X-Api-Key'; value: string }
export class PluginHttpBroker {
  private pending = new Map<string, number>()
  private total = 0
  constructor(private readonly credential: (pluginId: string, id: string) => PluginCredentialValue | undefined) {}
  async request(
    pluginId: string,
    grant: PluginGrant,
    mode: 'plan' | 'default',
    input: PluginHttpRequest,
    cancellation: AbortSignal,
  ): Promise<PluginHttpResponse> {
    if (
      !input ||
      typeof input.url !== 'string' ||
      typeof input.method !== 'string' ||
      (input.body !== undefined && typeof input.body !== 'string') ||
      (input.headers !== undefined &&
        (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)))
    )
      throw new Error('invalid-input: 网络请求格式无效')
    if (!grant.restricted.capabilities?.includes('http.request')) throw new Error('permission-denied: 未授权网络能力')
    if (this.total >= 32 || (this.pending.get(pluginId) ?? 0) >= 4) throw new Error('permission-denied: 网络请求过多')
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(30000)])
    signal.throwIfAborted()
    const method = String(input.method).toUpperCase()
    if (mode === 'plan' && !['GET', 'HEAD'].includes(method))
      throw new Error('permission-denied: Plan 网络只允许 GET/HEAD')
    if (Buffer.byteLength(input.body ?? '') > 262144) throw new Error('payload-too-large: 请求正文过大')
    if (Buffer.byteLength(JSON.stringify(input.headers ?? {})) > 16384) throw new Error('payload-too-large: 请求头过大')
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (
        /^(?:host|connection|upgrade|proxy-.*|cookie|set-cookie|origin|referer|forwarded|x-forwarded-.*|transfer-encoding|content-length|authorization|x-api-key|accept-encoding)$/i.test(
          name,
        )
      )
        throw new Error('permission-denied: 请求包含禁止设置的头')
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('invalid-input: 请求头无效')
      headers[name] = value
    }
    let url = this.authorize(input.url, method, grant)
    if (input.credentialRef) {
      const secret = this.credential(pluginId, input.credentialRef)
      if (!secret || secret.origin !== url.origin) throw new Error('permission-denied: 凭据不属于此插件目标')
      headers[secret.header] = secret.header === 'Authorization' ? `Bearer ${secret.value}` : secret.value
    }
    this.total++
    this.pending.set(pluginId, (this.pending.get(pluginId) ?? 0) + 1)
    try {
      const origin = url.origin
      for (let redirects = 0; redirects <= 3; redirects++) {
        signal.throwIfAborted()
        const result = await this.once(url, method, headers, input.body, signal)
        if (result.status >= 300 && result.status < 400 && result.headers.location) {
          if (redirects === 3) throw new Error('network-redirect-denied: 重定向次数过多')
          url = this.authorize(new URL(result.headers.location, url).href, method, grant)
          if (url.origin !== origin) throw new Error('network-redirect-denied: 不允许跨 origin 重定向')
          continue
        }
        return result
      }
      throw new Error('network-redirect-denied: 无法完成重定向')
    } finally {
      this.total--
      this.pending.set(pluginId, (this.pending.get(pluginId) ?? 1) - 1)
    }
  }
  private authorize(value: string, method: string, grant: PluginGrant) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('invalid-input: 网络 URL 无效')
    }
    if (
      value.length > 8192 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !grant.restricted.network?.some((r) => r.origin === url.origin && r.methods.includes(method as never))
    )
      throw new Error('network-origin-denied: 网络目标或方法未授权')
    return url
  }
  private async once(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<PluginHttpResponse> {
    const resolver = new Resolver({ timeout: 5000, tries: 1 })
    const abortDns = () => resolver.cancel()
    signal.addEventListener('abort', abortDns, { once: true })
    let addresses: Array<{ address: string; family: 4 | 6 }>
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(url.hostname), resolver.resolve6(url.hostname)])
      addresses = [
        ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
        ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
      ]
    } finally {
      signal.removeEventListener('abort', abortDns)
    }
    signal.throwIfAborted()
    if (!addresses!.length || addresses!.some((v) => !publicPluginAddress(v.address)))
      throw new Error('network-address-denied: DNS 包含非公开地址')
    const pinned = addresses![0]
    return new Promise((resolve, reject) => {
      const agent = new https.Agent({ keepAlive: false, proxyEnv: {} })
      const request = https.request(
        url,
        {
          method,
          headers,
          signal,
          agent,
          family: pinned.family,
          maxHeaderSize: 16384,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        },
        (response) => {
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy()
            reject(new Error('invalid-output: 不支持压缩网络响应'))
            return
          }
          let size = 0
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 1048576) response.destroy(new Error('payload-too-large: 网络响应过大'))
            else chunks.push(chunk)
          })
          response.once('error', (cause) => {
            agent.destroy()
            reject(cause)
          })
          response.once('end', () => {
            const clean: Record<string, string> = {}
            for (const [key, value] of Object.entries(response.headers))
              if (
                value !== undefined &&
                !/^(?:set-cookie|authorization|proxy-.*|connection|transfer-encoding)$/i.test(key)
              )
                clean[key] = Array.isArray(value) ? value.join(', ') : value
            agent.destroy()
            resolve({ status: response.statusCode ?? 0, headers: clean, body: Buffer.concat(chunks).toString('utf8') })
          })
        },
      )
      request.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          if (
            !socket.remoteAddress ||
            ipaddr.parse(socket.remoteAddress).toNormalizedString() !==
              ipaddr.parse(pinned.address).toNormalizedString()
          )
            request.destroy(new Error('network-address-denied: 连接地址与批准 DNS 不一致'))
        })
      })
      request.once('error', (cause) => {
        agent.destroy()
        reject(cause)
      })
      request.end(body)
    })
  }
}
