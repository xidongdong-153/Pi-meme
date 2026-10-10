import type { Session } from 'electron'

export async function authenticateRemoteHost(
  session: Pick<Session, 'fetch'>,
  url: string,
  token: string,
  expectedHostId?: string,
) {
  const address = new URL(url)
  if (address.protocol !== 'https:' || address.username || address.password)
    throw new Error('远程 Host 必须使用 HTTPS，地址不能包含凭据')
  const response = await session.fetch(`${address.origin}/api/auth`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!response.ok) throw new Error('远程 Host 认证失败，请更新访问令牌')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('hostId' in value) || typeof value.hostId !== 'string' || !value.hostId)
    throw new Error('远程 Host 没有返回有效身份')
  if (expectedHostId && value.hostId !== expectedHostId) throw new Error('远程 Host 身份已变化，请重新输入访问令牌')
  return value.hostId
}
