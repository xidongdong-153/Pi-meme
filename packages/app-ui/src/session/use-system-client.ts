import { useEffect } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { BrowserPlatform } from '@pi-meme/contracts/browser'
import { migrateAppearance, validateAppearance } from '@pi-meme/settings/shared/appearance'

export function useSystemClient(bridge: DesktopBridge, browser?: BrowserPlatform, hostId?: string) {
  useEffect(() => {
    const remove = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionIds: string[] }>).detail
      if (detail.hostId !== hostId) return
      for (const sessionId of detail.sessionIds) {
        for (const prefix of ['pi-meme:panels:v2:', 'pi-meme:sidebar:v1:']) {
          try {
            localStorage.removeItem(prefix + JSON.stringify([hostId, sessionId]))
          } catch {
            /* 存储不可用不阻止资源清理。 */
          }
        }
        if (browser) {
          const owner = JSON.stringify([hostId, sessionId])
          void browser
            .workspace(owner)
            .then(async (workspace) => {
              for (const tab of workspace.tabs) await browser.close(tab.id)
              await browser.saveWorkspace(owner, { tabs: [], annotations: [] })
            })
            .catch((cause) => console.error('删除会话后的网页清理失败', cause))
        }
      }
    }
    window.addEventListener('pi-meme:sessions-deleted', remove)
    return () => window.removeEventListener('pi-meme:sessions-deleted', remove)
  }, [browser, hostId])
  useEffect(
    () =>
      bridge.registerSystemClient?.(
        [
          'appearance.get',
          'appearance.save',
          ...(browser?.agent
            ? [
                'browser.list',
                'browser.read',
                'browser.screenshot',
                'browser.open',
                'browser.navigate',
                'browser.click',
                'browser.input',
                'browser.scroll',
                'browser.close',
              ]
            : []),
        ],
        async (request) => {
          if (!hostId || request.session.hostId !== hostId) throw new Error('客户端请求的 Host 身份不匹配')
          if (request.operation.startsWith('browser.')) {
            if (!browser?.agent) throw new Error('当前客户端不支持 Desktop 网页操作')
            const owner = JSON.stringify([request.session.hostId, request.session.sessionId])
            return browser.agent(owner, request.operation.slice(8), request.args)
          }
          const snapshot = await bridge.getSettings()
          const appearance = migrateAppearance(snapshot.settings, snapshot.themes)
          const hash = async (value: unknown) =>
            [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
          const revision = await hash(appearance)
          if (request.operation === 'appearance.get') return { appearance, revision }
          if (request.operation !== 'appearance.save') throw new Error('客户端操作不支持')
          if (request.args[1] !== revision) throw new Error('外观已变化，请重新读取')
          const patch = request.args[0]
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('外观修改参数无效')
          const next = { ...appearance, ...patch }
          validateAppearance(next)
          await bridge.saveAppearance(next)
          return { appearance: next, revision: await hash(next) }
        },
      ),
    [bridge, browser, hostId],
  )
}
