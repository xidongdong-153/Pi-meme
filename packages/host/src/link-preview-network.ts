import https from 'node:https'
import { isIP } from 'node:net'
import { resolveNetworkAddresses, type NetworkAddress } from './plugin-http-broker'

/** 仅在系统 DNS 返回代理的 Fake-IP 时使用；连接仍由 broker 校验并固定到公开地址。 */
export async function resolveLinkPreviewAddresses(hostname: string, signal: AbortSignal): Promise<NetworkAddress[]> {
  const addresses = await resolveNetworkAddresses(hostname, signal)
  if (!addresses.length || !addresses.every(({ address }) => /^198\.(?:18|19)\./.test(address))) return addresses

  // 固定 HTTPS 解析器的公开 IP，避免再次经过 Fake-IP DNS；不携带 Cookie 或凭据。
  const url = new URL('https://1.1.1.1/dns-query')
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', 'A')
  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(4000)])
  const agent = new https.Agent({ keepAlive: false, proxyEnv: {} })
  return new Promise((resolve, reject) => {
    const fail = (cause: unknown) => {
      agent.destroy()
      reject(cause)
    }
    const request = https.get(
      url,
      { agent, signal: cancellation, maxHeaderSize: 16384, headers: { accept: 'application/dns-json' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy()
          fail(new Error('无法解析网页的公开地址'))
          return
        }
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) response.destroy(new Error('网页地址解析响应过大'))
          else chunks.push(chunk)
        })
        response.once('error', fail)
        response.once('end', () => {
          try {
            const result: { Status?: number; Answer?: Array<{ type?: number; data?: string }> } = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            )
            const resolved: NetworkAddress[] = []
            if (result.Status === 0 && Array.isArray(result.Answer)) {
              for (const answer of result.Answer) {
                if (answer?.type === 1 && typeof answer.data === 'string' && isIP(answer.data) === 4)
                  resolved.push({ address: answer.data, family: 4 })
              }
            }
            resolve(resolved)
          } catch (cause) {
            reject(cause)
          } finally {
            agent.destroy()
          }
        })
      },
    )
    request.once('error', fail)
  })
}
