import { recoveryUrl } from '../window/recovery-page'

export function isTrustedPlatformSource(url: string, trustedOrigin: string, channel: string, args: unknown[]) {
  if (url === recoveryUrl)
    return (
      channel === 'platform:connection-error' ||
      channel === 'platform:retry-connection' ||
      (channel === 'platform:set-connection' &&
        (args[0] === null ||
          (typeof args[0] === 'object' && args[0] !== null && 'url' in args[0] && 'token' in args[0])))
    )
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol) && new URL(url).origin === trustedOrigin
  } catch {
    return false
  }
}
