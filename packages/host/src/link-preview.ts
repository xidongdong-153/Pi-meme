import type { LinkPreview } from '@pi-meme/contracts/link-preview'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'
import { PluginHttpBroker } from './plugin-http-broker'

function decodeText(value: string) {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
      const point = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
    })
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name: string) => {
      return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[name]!
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
}

export function parseLinkPreview(html: string, url: string): LinkPreview {
  const head = html.split(/<\/head\s*>/i, 1)[0].replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>/gi, '')
  const metadata = new Map<string, string>()
  let icon: string | undefined
  const safeUrl = (value?: string) => {
    if (!value) return undefined
    try {
      const target = new URL(value, url)
      return target.protocol === 'https:' && !target.username && !target.password ? target.href : undefined
    } catch {
      return undefined
    }
  }
  for (const match of head.matchAll(/<(meta|link)\b([^>]+)>/gi)) {
    const attributes = new Map<string, string>()
    for (const attribute of match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      attributes.set(attribute[1].toLowerCase(), decodeText(attribute[2] ?? attribute[3] ?? attribute[4]))
    }
    const name = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase()
    if (name && !metadata.has(name)) metadata.set(name, attributes.get('content') ?? '')
    if (match[1].toLowerCase() === 'link' && /(?:^|\s)icon(?:\s|$)/i.test(attributes.get('rel') ?? '')) {
      icon ??= safeUrl(attributes.get('href'))
    }
  }
  return {
    url,
    title:
      metadata.get('og:title') ||
      metadata.get('twitter:title') ||
      decodeText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ''),
    description: metadata.get('og:description') || metadata.get('description') || metadata.get('twitter:description'),
    image: safeUrl(metadata.get('og:image') || metadata.get('twitter:image')),
    icon,
  }
}

/** 复用网络代理的 DNS 固定、公开地址校验、大小限制和并发限制；不带用户凭据。 */
export function createLinkPreviewLoader() {
  const broker = new PluginHttpBroker(() => undefined)
  const cache = new Map<string, { expires: number; result: Promise<LinkPreview> }>()
  return (input: unknown): Promise<LinkPreview> => {
    if (typeof input !== 'string' || input.length > 8192) throw new Error('链接地址无效')
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('仅支持公开 HTTPS 网页预览')
    url.hash = ''
    const key = url.href
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.result
    const grant = emptyPluginGrant('builtin-link-preview')
    grant.restricted.capabilities = ['http.request']
    grant.restricted.network = [{ id: 'preview', origin: url.origin, methods: ['GET'] }]
    const result = broker
      .request(
        'builtin-link-preview',
        grant,
        'plan',
        { url: key, method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Pi-meme-Link-Preview' } },
        AbortSignal.timeout(8000),
      )
      .then((response) => {
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !response.headers['content-type']?.includes('text/html')
        ) {
          throw new Error('网页未提供可用的预览')
        }
        return parseLinkPreview(response.body, key)
      })
    cache.delete(key)
    if (cache.size >= 128) cache.delete(cache.keys().next().value!)
    cache.set(key, { expires: Date.now() + 5 * 60_000, result })
    return result
  }
}
