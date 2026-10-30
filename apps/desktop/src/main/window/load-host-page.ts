import { recoveryUrl } from './recovery-page'

export async function loadHostPage(
  window: { loadURL: (url: string) => Promise<unknown> },
  url: string,
  previousUrl?: string,
  rollback?: () => void,
) {
  try {
    await window.loadURL(url)
  } catch (cause) {
    rollback?.()
    try {
      await window.loadURL(previousUrl || recoveryUrl)
    } catch {
      await window.loadURL(recoveryUrl)
    }
    throw new Error(`无法连接服务，请检查地址和网络：${String(cause)}`)
  }
}

export async function retryHostPage(
  window: { loadURL: (url: string) => Promise<unknown> },
  resolveUrl: () => Promise<string>,
  configurationError?: Error,
) {
  if (configurationError) throw configurationError
  await loadHostPage(window, await resolveUrl())
}
