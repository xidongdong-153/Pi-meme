import { computerOperations, desktopComputer } from '@pi-meme/contracts/computer-use'
import { useEffect, useRef } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { BrowserPlatform } from '@pi-meme/contracts/browser'
import {
  browserAgentOperations,
  browserWaitDefaultMs,
  type BrowserWaitObservation,
  type BrowserWaitResult,
} from '@pi-meme/contracts/browser-agent'
import { migrateAppearance, resolvedMode, resolveTheme } from '@pi-meme/settings/shared/appearance'
import { clientReadDefinitions, clientReadList, systemMetadataUrl } from '@pi-meme/contracts/system-client-reads'
import type { SystemClientRequest, SystemClientExecutionContext } from '@pi-meme/contracts/system-tools'
import type { Theme, AppearancePatch } from '@pi-meme/contracts/settings'
import type { AppearanceController } from '@pi-meme/settings/ui/appearance-provider'
import {
  readRevision,
  SystemReadError,
  type ReadErrorCode,
  type SystemReadErrorDetails,
} from '@pi-meme/contracts/system-read'
import { visualizationClientOperationDefinitions } from '@pi-meme/contracts/visualize'

const visualizationClientOperations = new Set(
  visualizationClientOperationDefinitions.map((definition) => definition.name),
)

const browserWrites = new Set([
  'browser.open',
  'browser.navigate',
  'browser.close',
  ...browserAgentOperations.filter(({ write }) => write).map(({ name }) => name),
])

async function callBrowser(
  agent: NonNullable<BrowserPlatform['agent']>,
  owner: string,
  request: SystemClientRequest,
  deadline = request.deadline,
) {
  const result = await agent(owner, request.operation.slice(8), request.args, deadline)
  if (result && typeof result === 'object' && 'type' in result && result.type === 'browser-agent-read-error') {
    const failure = result as {
      type: 'browser-agent-read-error'
      errorCode: ReadErrorCode
      error: string
      errorDetails?: SystemReadErrorDetails
    }
    throw new SystemReadError(failure.errorCode, failure.error, failure.errorDetails)
  }
  return result
}

async function waitForBrowser(
  agent: NonNullable<BrowserPlatform['agent']>,
  owner: string,
  request: SystemClientRequest,
  context: SystemClientExecutionContext,
): Promise<BrowserWaitResult> {
  const timeoutMs = (request.args[2] as { timeoutMs?: number } | undefined)?.timeoutMs ?? browserWaitDefaultMs
  const deadline = Math.min(Date.now() + timeoutMs, request.deadline - 1_500)
  const probeDeadline = deadline + 500
  let latest: BrowserWaitObservation | undefined
  for (;;) {
    await context.confirmPending()
    try {
      latest = (await callBrowser(agent, owner, request, probeDeadline)) as BrowserWaitObservation
    } catch (cause) {
      if (!latest || !(cause instanceof SystemReadError) || cause.code !== 'timeout' || Date.now() < deadline)
        throw cause
    }
    context.assertActive()
    const remaining = deadline - Date.now()
    if (latest.matched || remaining <= 0) {
      const { matched, ...observation } = latest
      return { ...observation, status: matched ? 'matched' : 'timed-out' }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)))
  }
}

export function useSystemClient(
  bridge: DesktopBridge,
  browser?: BrowserPlatform,
  hostId?: string,
  appearanceBridge: DesktopBridge = bridge,
  readSnapshot?: (request: SystemClientRequest) => Promise<unknown>,
  readAppearance?: AppearanceController['getSystemSnapshot'],
  handleVisualization?: (request: SystemClientRequest, context: SystemClientExecutionContext) => Promise<unknown>,
) {
  const computer = desktopComputer()
  const environment = { browser, computer, hostId, appearanceBridge, readSnapshot, readAppearance, handleVisualization }
  const latest = useRef(environment)
  latest.current = environment
  const client = useRef<ReturnType<NonNullable<DesktopBridge['registerSystemClient']>>>(undefined)
  const hasComputer = Boolean(computer)
  const hasBrowser = Boolean(browser?.agent)
  const hasBrowserInteraction = hasBrowser && browser?.agentInteraction === true
  const hasRead = Boolean(readSnapshot)
  const hasVisualization = Boolean(handleVisualization)
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
  useEffect(() => {
    const browserWritesByTab = new Map<string, Promise<unknown>>()
    const registration = bridge.registerSystemClient?.(
      async (request, context) => {
        const { browser, computer, hostId, appearanceBridge, readSnapshot, handleVisualization } = latest.current
        if (!hostId || request.session.hostId !== hostId) throw new Error('客户端请求的 Host 身份不匹配')
        if (request.operation.startsWith('computer.')) {
          if (!computer || !request.executionId) throw new SystemReadError('not-supported', '当前客户端不支持电脑操控')
          if (request.operation === 'computer.end') return computer.release(request.registrationId, request.executionId)
          await context.confirmPending()
          const decision = await computer.authorize(request)
          if (!decision.ok) throw new SystemReadError(decision.code, decision.message, decision.details)
          try {
            await context.confirmPending()
          } catch (cause) {
            await computer.stop(request.executionId)
            throw cause
          }
          const reply = await computer.execute(request)
          if (!reply.ok) throw new SystemReadError(reply.code, reply.message, reply.details)
          return reply.result
        }
        if (visualizationClientOperations.has(request.operation)) {
          if (!handleVisualization) throw new SystemReadError('not-supported', '当前客户端不支持可视化运行时 v2')
          return handleVisualization(request, context)
        }
        if (request.operation.startsWith('browser.')) {
          const agent = browser?.agent
          if (!agent) throw new SystemReadError('not-supported', '当前客户端不支持 Desktop 网页操作')
          const owner = JSON.stringify([request.session.hostId, request.session.sessionId])
          if (request.operation === 'browser.waitFor') return waitForBrowser(agent, owner, request, context)
          if (!browserWrites.has(request.operation)) return callBrowser(agent, owner, request)
          const write = async () => {
            await context.confirmPending()
            return callBrowser(agent, owner, request)
          }
          if (request.operation === 'browser.open' || request.operation === 'browser.downloads.saveToWorkspace')
            return write()
          const key = JSON.stringify([owner, request.args[0]])
          const previous = browserWritesByTab.get(key)
          const pending = previous ? previous.then(write, write) : write()
          browserWritesByTab.set(key, pending)
          try {
            return await pending
          } finally {
            if (browserWritesByTab.get(key) === pending) browserWritesByTab.delete(key)
          }
        }
        if (
          request.operation !== 'appearance.get' &&
          request.operation !== 'appearance.save' &&
          request.operation !== 'appearance.effective' &&
          !request.operation.startsWith('themes.')
        ) {
          if (!readSnapshot) throw new Error('客户端界面快照尚不可用')
          return readSnapshot(request)
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
          const actual = latest.current.readAppearance?.()
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
      (registrationId) => {
        void latest.current.computer?.release(registrationId).catch(() => {})
      },
    )
    client.current = registration
    return () => {
      client.current = undefined
      registration?.dispose()
    }
  }, [bridge])
  useEffect(() => {
    client.current?.updateOperations([
      ...(hasComputer ? computerOperations.map((op) => op.name) : []),
      'appearance.get',
      'appearance.save',
      ...(hasVisualization ? [...visualizationClientOperations] : []),
      ...clientReadDefinitions
        .filter((definition) =>
          definition.name === 'client.projectApps.list' && !supportsProjectApps
            ? false
            : definition.name.startsWith('browser.')
              ? hasBrowser
              : definition.name.startsWith('themes.') || definition.name === 'appearance.effective' || hasRead,
        )
        .map((definition) => definition.name),
      ...(hasBrowser
        ? [
            'browser.list',
            ...browserAgentOperations
              .filter(({ name }) => name === 'browser.read' || hasBrowserInteraction)
              .map(({ name }) => name),
            'browser.screenshot',
            'browser.open',
            'browser.navigate',
            'browser.close',
          ]
        : []),
    ])
  }, [bridge, hasBrowser, hasBrowserInteraction, hasComputer, hasRead, hasVisualization, supportsProjectApps])
}
