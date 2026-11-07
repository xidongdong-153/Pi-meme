export const hostSessionCookiePrefix = 'pi_meme_session_'
export const controlPlaneResponseHeader = 'X-Pi-Meme-Control-Plane'
export const controlPlaneResponseValue = '1'

/** Host 认证通道建立的身份；请求体中的 clientId 仅用于界面路由。 */
export type TransportIdentity = {
  principalId: string
  installationId: string
  connectionEpoch: string
  role: 'owner'
  hostId: string
}

/** 仅供可信父进程/服务内部签发，不提供 HTTP 签发入口。 */
export type BootstrapTicketOptions = {
  installationId?: string
}
