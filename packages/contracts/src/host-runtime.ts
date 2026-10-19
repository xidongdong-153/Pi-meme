export const defaultHostPort = 31415
export const defaultDevelopmentHostPort = 31416
export const hostRuntimeProtocolVersion = 1

export type LocalHostStatus = {
  product: 'pi-meme'
  runtimeProtocolVersion: typeof hostRuntimeProtocolVersion
  hostId: string
  instanceId: string
  dataRoot: string
  owner: 'desktop' | 'server'
}

export function hostPort(value?: string, defaultPort = defaultHostPort) {
  if (value === undefined) return defaultPort
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('PI_MEME_PORT 必须是 0 到 65535 的整数')
  return Number(value)
}

export function localHostUrl(port = defaultHostPort) {
  return `http://127.0.0.1:${port}`
}
