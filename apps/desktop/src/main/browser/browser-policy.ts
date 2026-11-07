import {
  controlPlaneResponseHeader,
  controlPlaneResponseValue,
  hostSessionCookiePrefix,
} from '@pi-meme/contracts/transport-identity'

function reservedCookie(pair: string, allowed?: ReadonlySet<string>) {
  const separator = pair.indexOf('=')
  const name = (separator < 0 ? pair : pair.slice(0, separator)).trim()
  const reserved = name.toLowerCase() === 'pi_meme_session' || name.toLowerCase().startsWith(hostSessionCookiePrefix)
  return reserved && !allowed?.has(name)
}

/** Business requests omit the allowlist; only the Owner session supplies exact origin-bound cookie names. */
export function businessRequestHeaders(source: Record<string, string>, allowed?: ReadonlySet<string>) {
  const headers = { ...source }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'cookie') continue
    const kept = value
      .split(';')
      .filter((pair) => !reservedCookie(pair, allowed))
      .join(';')
    if (kept.trim()) headers[key] = kept
    else delete headers[key]
  }
  return headers
}

/** Each Set-Cookie line is independent: commas inside Expires must remain intact. */
export function businessResponseHeaders(source: Record<string, string[]>, allowed?: ReadonlySet<string>) {
  const headers = { ...source }
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'set-cookie') continue
    const kept = values.filter((value) => !reservedCookie(value.split(';', 1)[0], allowed))
    if (kept.length) headers[key] = kept
    else delete headers[key]
  }
  return headers
}

export function controlPlaneResponse(headers: Record<string, string[]>) {
  return Object.entries(headers).some(
    ([key, values]) =>
      key.toLowerCase() === controlPlaneResponseHeader.toLowerCase() &&
      values.some((value) => value.split(',').some((item) => item.trim() === controlPlaneResponseValue)),
  )
}

function originOf(value: string) {
  try {
    const url = new URL(value)
    // HTTP control endpoints and their WebSocket upgrades share the same boundary.
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    const origin = url.origin
    return /^https?:\/\//.test(origin) ? origin : undefined
  } catch {
    return undefined
  }
}

export class BrowserControlPolicy {
  private readonly origins = new Set<string>()
  private loading: Promise<void> | undefined

  constructor(private readonly readOrigins: () => Promise<readonly string[]>) {}

  remember(value: string) {
    const origin = originOf(value)
    if (origin) this.origins.add(origin)
  }

  isControlPlane(value: string) {
    const origin = originOf(value)
    return !!origin && this.origins.has(origin)
  }

  assertBusinessUrl(value: string) {
    if (this.isControlPlane(value)) throw new Error('Agent 不允许读取或操作 Host 控制台，请打开业务网页')
  }

  async refresh() {
    // Keep one metadata request in flight even when callers time out. Do not retry a stuck request per frame.
    this.loading ??= Promise.resolve()
      .then(() => this.readOrigins())
      .then((origins) => {
        if (!Array.isArray(origins) || !origins.length || origins.length > 10000)
          throw new Error('Host 控制面地址清单无效')
        for (const value of origins) {
          if (typeof value !== 'string' || originOf(value) !== value) throw new Error('Host 控制面地址无效')
          this.origins.add(value)
        }
      })
      .finally(() => {
        this.loading = undefined
      })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.loading,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Host 控制面地址读取超时，拒绝网页操作')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
}
