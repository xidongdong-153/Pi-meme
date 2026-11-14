import type { LinkPreview } from '@pi-meme/contracts/link-preview'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'
import { PluginHttpBroker } from './plugin-http-broker'
import { resolveLinkPreviewAddresses } from './link-preview-network'
import { htmlHeadEnd } from './html-head'

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
}

export function parseLinkPreview(html: string, url: string): LinkPreview {
  const head = html
    .slice(0, htmlHeadEnd(html) ?? html.length)
    .replace(/<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const metadata = new Map<string, string>()
  let icon: string | undefined
  let base: string | undefined
  const safeUrl = (value?: string, relativeTo = base ?? url) => {
    if (!value) return undefined
    try {
      const target = new URL(value, relativeTo)
      return target.protocol === 'https:' && !target.username && !target.password ? target.href : undefined
    } catch {
      return undefined
    }
  }
  for (const match of head.matchAll(/<(meta|link|base)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const attributes = new Map<string, string>()
    for (const attribute of match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      attributes.set(attribute[1].toLowerCase(), decodeText(attribute[2] ?? attribute[3] ?? attribute[4]))
    }
    if (match[1].toLowerCase() === 'base') base ??= safeUrl(attributes.get('href'), url)
    const name = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase()
    if (name && !metadata.has(name)) metadata.set(name, attributes.get('content') ?? '')
    if (match[1].toLowerCase() === 'link' && /(?:^|\s)icon(?:\s|$)/i.test(attributes.get('rel') ?? '')) {
      icon ??= attributes.get('href')
    }
  }
  return {
    url,
    title: (
      metadata.get('og:title') ||
      metadata.get('twitter:title') ||
      decodeText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '')
    ).slice(0, 1000),
    description: (
      metadata.get('og:description') ||
      metadata.get('description') ||
      metadata.get('twitter:description')
    )?.slice(0, 1000),
    image: safeUrl(metadata.get('og:image') || metadata.get('twitter:image')),
    icon: safeUrl(icon),
  }
}

/** 只读取有界 HTML 头部；每次跳转仍校验公开地址并固定 DNS，不携带用户凭据。 */
export function createLinkPreviewLoader() {
  const broker = new PluginHttpBroker(() => undefined, {
    htmlHeadOnly: true,
    followRedirects: false,
    resolveAddresses: resolveLinkPreviewAddresses,
  })
  const cache = new Map<string, { expires: number; result: Promise<LinkPreview> }>()
  return (input: unknown): Promise<LinkPreview> => {
    if (typeof input !== 'string' || input.length > 8192) throw new Error('链接地址无效')
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('仅支持公开 HTTPS 网页预览')
    url.hash = ''
    const key = url.href
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.result
    const load = async () => {
      const signal = AbortSignal.timeout(12000)
      let target = url
      for (let redirects = 0; redirects <= 3; redirects++) {
        const grant = emptyPluginGrant('builtin-link-preview')
        grant.restricted.capabilities = ['http.request']
        grant.restricted.network = [{ id: 'preview', origin: target.origin, methods: ['GET'] }]
        const response = await broker.request(
          'builtin-link-preview',
          grant,
          'plan',
          { url: target.href, method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Pi-meme-Link-Preview' } },
          signal,
        )
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          target = new URL(response.headers.location, target)
          continue
        }
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] ?? '')
        ) {
          throw new Error('网页未提供可用的预览')
        }
        return parseLinkPreview(response.body, target.href)
      }
      throw new Error('网页重定向次数过多')
    }
    const result: Promise<LinkPreview> = load().catch((cause) => {
      if (cache.get(key)?.result === result) cache.delete(key)
      throw cause
    })
    cache.delete(key)
    if (cache.size >= 128) cache.delete(cache.keys().next().value!)
    cache.set(key, { expires: Date.now() + 5 * 60_000, result })
    return result
  }
}
