import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import ipaddr from 'ipaddr.js'
import { maxImagePreviewBytes } from '@pi-meme/contracts/app-host'

export async function readResponse(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('图片服务响应超过大小限制')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('图片服务返回空响应')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > limit) throw new Error('图片服务响应超过大小限制')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

export function publicImageAddress(value: string) {
  const address = ipaddr.process(value)
  return address.range() === 'unicast'
}

/** 下载地址不继承模型凭据；固定 DNS 结果，逐跳检查 origin。 */
export async function downloadImage(rawUrl: string, configuredOrigin: string, signal: AbortSignal): Promise<Buffer> {
  let url = new URL(rawUrl)
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted()
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.origin !== configuredOrigin && url.protocol !== 'https:')
    )
      throw new Error('图片下载地址不允许访问')
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = await lookup(hostname, { all: true })
    signal.throwIfAborted()
    if (
      !addresses.length ||
      (url.origin !== configuredOrigin && addresses.some((item) => !publicImageAddress(item.address)))
    )
      throw new Error('图片下载地址包含未经配置允许的本机或私网地址')
    const address = addresses[0]
    const next = await new Promise<{ bytes?: Buffer; location?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          agent: false,
          family: address.family,
          signal,
          headers: { 'accept-encoding': 'identity' },
          lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume()
            resolve({ location: response.headers.location })
            return
          }
          if (response.statusCode !== 200) {
            response.resume()
            reject(new Error('无法下载图片服务返回的文件'))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > maxImagePreviewBytes) request.destroy(new Error('生成图片超过 8 MiB'))
            else chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }))
        },
      )
      request.on('error', reject)
    })
    if (next.bytes) return next.bytes
    if (redirects === 3) throw new Error('图片下载重定向次数过多')
    url = new URL(next.location!, url)
  }
  throw new Error('无法下载图片')
}
