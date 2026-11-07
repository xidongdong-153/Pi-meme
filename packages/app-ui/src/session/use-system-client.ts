import { useEffect } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { BrowserPlatform } from '@pi-meme/contracts/browser'
import { migrateAppearance } from '@pi-meme/settings/shared/appearance'
import type { AppearancePatch } from '@pi-meme/contracts/settings'

// Module lifetime is the actual UI document lifetime; remounts keep the same UUID.
const documentUUID = crypto.randomUUID()

export function useSystemClient(
  bridge: DesktopBridge,
  browser?: BrowserPlatform,
  hostId?: string,
  appearanceBridge: DesktopBridge = bridge,
) {
  useEffect(() => {
    const remove = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; sessionIds: string[] }>).detail
      if (detail.hostId !== hostId) return
      for (const sessionId of detail.sessionIds) {
        try {
          localStorage.removeItem(`pi-meme:panels:v2:${JSON.stringify([hostId, sessionId])}`)
        } catch {
          /* 存储不可用不阻止资源清理。 */
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
  useEffect(() => {
    let active = true
    let unregister: (() => void) | undefined
    const register = async () => {
      if (browser?.agent) {
        if (!browser.bindAgentDocument) throw new Error('当前 Desktop 不支持文档绑定，请更新应用')
        await browser.bindAgentDocument(documentUUID)
      }
      if (!active) return
      unregister = bridge.registerSystemClient?.(
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
        async (request, execution) => {
          if (!active || request.permit.documentUUID !== documentUUID) throw new Error('客户端文档已失效')
          if (!hostId || request.session.hostId !== hostId) throw new Error('客户端请求的 Host 身份不匹配')
          if (request.operation.startsWith('browser.')) {
            if (!browser?.agent) throw new Error('当前客户端不支持 Desktop 网页操作')
            const owner = JSON.stringify([request.session.hostId, request.session.sessionId])
            return browser.agent(owner, request.operation.slice(8), request.args, execution.native)
          }
          if (appearanceBridge !== bridge) throw new Error('外观操作不能跨 Host 转发，请在外观所属 Host 发起')
          if (request.operation === 'appearance.get') {
            await execution.claim()
            const snapshot = await appearanceBridge.getSettings()
            const revision = snapshot.appearanceRevision
            if (!revision) throw new Error('外观 Host 不支持受控保存，请更新服务')
            return { appearance: migrateAppearance(snapshot.settings, snapshot.themes), revision }
          }
          if (request.operation !== 'appearance.save') throw new Error('客户端操作不支持')
          if (typeof request.args[1] !== 'string') throw new Error('保存外观必须携带读取时的修订')
          const patch = request.args[0]
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('外观修改参数无效')
          if (!active) throw new Error('客户端文档已失效')
          await execution.claim()
          const result = await appearanceBridge.saveAppearance({
            expectedRevision: request.args[1],
            operation: { type: 'patch', patch: patch as AppearancePatch },
          })
          if (result.status === 'conflict') throw new Error('外观已变化，请重新读取；本次修改未覆盖最新配置')
          return {
            appearance: migrateAppearance(result.snapshot.settings, result.snapshot.themes),
            revision: result.snapshot.appearanceRevision,
          }
        },
        { documentUUID },
      )
    }
    void register().catch((cause) => console.error('系统客户端注册失败', cause))
    return () => {
      active = false
      unregister?.()
    }
  }, [bridge, browser, hostId, appearanceBridge])
}
