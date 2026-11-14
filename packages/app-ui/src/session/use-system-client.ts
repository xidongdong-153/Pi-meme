import { useEffect, useRef } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { BrowserPlatform } from '@pi-meme/contracts/browser'
import { migrateAppearance, resolvedMode, resolveTheme } from '@pi-meme/settings/shared/appearance'
import { clientReadDefinitions, clientReadList, systemMetadataUrl } from '@pi-meme/contracts/system-client-reads'
import type { SystemClientRequest } from '@pi-meme/contracts/system-tools'
import type { Theme, AppearancePatch } from '@pi-meme/contracts/settings'
import type { AppearanceController } from '@pi-meme/settings/ui/appearance-provider'
import { readRevision, SystemReadError, type ReadErrorCode } from '@pi-meme/contracts/system-read'

export function useSystemClient(
  bridge: DesktopBridge,
  browser?: BrowserPlatform,
  hostId?: string,
  appearanceBridge: DesktopBridge = bridge,
  readSnapshot?: (request: SystemClientRequest) => Promise<unknown>,
  readAppearance?: AppearanceController['getSystemSnapshot'],
) {
  const latestRead = useRef(readSnapshot)
  latestRead.current = readSnapshot
  const latestAppearance = useRef(readAppearance)
  latestAppearance.current = readAppearance
  const hasRead = Boolean(readSnapshot)
  const supportsProjectApps = Boolean(
    (window as Window & { piPlatform?: { getProjectApps?: unknown } }).piPlatform?.getProjectApps,
  )
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
  useEffect(
    () =>
      bridge.registerSystemClient?.(
        [
          'appearance.get',
          'appearance.save',
          ...clientReadDefinitions
            .filter((definition) =>
              definition.name === 'client.projectApps.list' && !supportsProjectApps
                ? false
                : definition.name.startsWith('browser.')
                  ? Boolean(browser?.agent)
                  : definition.name.startsWith('themes.') || definition.name === 'appearance.effective' || hasRead,
            )
            .map((definition) => definition.name),
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
            const result = await browser.agent(owner, request.operation.slice(8), request.args)
            if (
              result &&
              typeof result === 'object' &&
              'type' in result &&
              result.type === 'browser-agent-read-error'
            ) {
              const failure = result as { type: 'browser-agent-read-error'; errorCode: ReadErrorCode; error: string }
              throw new SystemReadError(failure.errorCode, failure.error)
            }
            return result
          }
          if (
            request.operation !== 'appearance.get' &&
            request.operation !== 'appearance.save' &&
            request.operation !== 'appearance.effective' &&
            !request.operation.startsWith('themes.')
          ) {
            if (!latestRead.current) throw new Error('客户端界面快照尚不可用')
            return latestRead.current(request)
          }
          const snapshot = await appearanceBridge.getSettings()
          const appearance = migrateAppearance(snapshot.settings, snapshot.themes)
          const revision = snapshot.appearanceRevision
          if (!revision) throw new Error('外观 Host 不支持受控保存，请更新服务')
          if (request.operation === 'appearance.get') return { appearance, revision }
          const themeMetadata = (theme: Theme) => ({
            id: theme.id,
            name: theme.name,
            appearance: theme.appearance,
            colors: theme.colors,
            fonts: theme.fonts,
            fontStyles: theme.fontStyles,
            tokens: theme.tokens,
            background: theme.background
              ? { ...theme.background, url: theme.background.url ? systemMetadataUrl(theme.background.url) : undefined }
              : undefined,
          })
          if (request.operation === 'themes.list')
            return {
              appearanceRevision: revision,
              ...clientReadList(
                snapshot.themes.map(({ id, name, appearance }) => ({ id, name, appearance })),
                request.args[0],
                'themes.list',
              ),
            }
          if (request.operation === 'themes.get') {
            if (typeof request.args[0] !== 'string') throw new Error('主题标识无效')
            const theme = snapshot.themes.find((theme) => theme.id === request.args[0])
            if (!theme) throw new Error('外观 Host 中不存在此主题')
            return { revision, theme: themeMetadata(theme) }
          }
          if (request.operation === 'appearance.effective') {
            const actual = latestAppearance.current?.()
            const systemDark = actual?.systemDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches
            const systemReducedMotion =
              actual?.systemMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches
            const effectiveSnapshot = actual?.snapshot ?? snapshot
            const effectiveAppearance = migrateAppearance(effectiveSnapshot.settings, effectiveSnapshot.themes)
            const mode = actual?.previewMode ?? resolvedMode(effectiveAppearance, systemDark)
            return {
              appearanceRevision: revision,
              revision: readRevision([effectiveAppearance, mode, systemReducedMotion]),
              appearance: effectiveAppearance,
              mode,
              systemDark,
              systemReducedMotion,
              pending: actual?.pending ?? 0,
              preview: Boolean(actual?.previewMode),
              reducedMotion:
                effectiveAppearance.reducedMotion === 'system'
                  ? systemReducedMotion
                  : effectiveAppearance.reducedMotion === 'on',
              theme: themeMetadata(resolveTheme(effectiveAppearance, effectiveSnapshot.themes, mode)),
            }
          }
          if (request.operation !== 'appearance.save') throw new Error('客户端操作不支持')
          if (typeof request.args[1] !== 'string') throw new Error('保存外观必须携带读取时的修订')
          const patch = request.args[0]
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('外观修改参数无效')
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
      ),
    [bridge, browser, hostId, appearanceBridge, hasRead, supportsProjectApps],
  )
}
