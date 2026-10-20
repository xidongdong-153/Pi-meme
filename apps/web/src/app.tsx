import type { ServiceRegistry } from '@pi-meme/app-ui/service-ui'
import { ServicesApp } from '@pi-meme/app-ui/services-app'
import { HostServiceRegistry } from '@pi-meme/client/service-registry'
import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from '@pi-meme/app-ui/app'
import { StartupSplash, useStartupSplash } from '@pi-meme/app-ui/startup-splash'
import { HostDirectoryDialog } from '@pi-meme/app-ui/host-directory-dialog'
import { HostClient } from '@pi-meme/client/host-client'
import { createAppHostClient } from '@pi-meme/client/app-host-client'
import type { HostConnection, HostDirectory, PlatformAdapter } from '@pi-meme/contracts/host'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { PluginClient } from '@pi-meme/client/plugin-client'

type DirectoryRequest = {
  load: (path?: string) => Promise<HostDirectory>
  resolve: (path: string | null) => void
}

async function fixtureUnavailable<T>(): Promise<T> {
  throw new Error('会话切换 fixture 不执行插件管理')
}
const fixtureHost = createAppHostClient({
  call: async <T,>(method: string): Promise<T> => {
    if (method === 'projects.list') return [] as T
    if (method === 'sessions.get') return { configuration: { agentPlugins: [] } } as T
    return fixtureUnavailable<T>()
  },
  subscribe: async () => () => {},
})
const fixturePlugins: PluginClient = {
  list: async () => [],
  installDirectory: fixtureUnavailable,
  installPackage: fixtureUnavailable,
  reload: fixtureUnavailable,
  enable: fixtureUnavailable,
  disable: fixtureUnavailable,
  remove: fixtureUnavailable,
  onChange: () => () => {},
}

function ServiceFixture() {
  const [registry] = useState<ServiceRegistry>(() => {
    const bridges = window.piMemeMultiServiceBridges!
    const services = Object.keys(bridges).map((id) => ({
      id,
      hostId: id,
      local: id === 'local',
      address: id === 'local' ? window.location.origin : `https://${id}.example.com:8443`,
      status: 'connected' as const,
      projects: [{ cwd: '/same', name: '同名项目', lastSelectedAt: '' }],
    }))
    const clients = new Map(
      Object.entries(bridges).map(([id, bridge]) => [
        id,
        { bridge, host: fixtureHost, plugins: fixturePlugins, rpc: fixtureUnavailable, nativePlatformAvailable: false },
      ]),
    )
    return {
      localServiceId: 'local',
      local: clients.get('local')!,
      get: (id) => clients.get(id)!,
      list: () => services,
      subscribe: () => () => {},
      initialize: async () => {},
      register: fixtureUnavailable,
      retry: fixtureUnavailable,
      remove: fixtureUnavailable,
      refresh: async () => {},
    }
  })
  return <ServicesApp registry={registry} nativeWindow />
}

export function WebApp() {
  if (
    new URLSearchParams(window.location.search).get('test-fixture') === 'multi-service' &&
    window.piMemeMultiServiceBridges
  )
    return <ServiceFixture />
  if (new URLSearchParams(window.location.search).get('test-fixture') === 'session-switch' && window.piMemeTestBridge)
    return (
      <App
        bridge={window.piMemeTestBridge}
        host={fixtureHost}
        plugins={fixturePlugins}
        call={fixtureUnavailable}
        nativeWindow
        onHostConnection={() => {}}
      />
    )
  return <ConnectedWebApp />
}

function ConnectedWebApp() {
  const [client, setClient] = useState<HostClient>()
  const [registry, setRegistry] = useState<HostServiceRegistry>()
  const registryRef = useRef<HostServiceRegistry | undefined>(undefined)
  const [directory, setDirectory] = useState<DirectoryRequest>()
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(true)
  const [chatReady, setChatReady] = useState(false)
  const splashPhase = useStartupSplash(Boolean(client) && chatReady)
  const markBootComplete = useCallback(() => setChatReady(true), [])
  const [token, setToken] = useState('')
  const clientRef = useRef<HostClient | undefined>(undefined)
  const directoryRef = useRef<DirectoryRequest | undefined>(undefined)
  const platform = window.piPlatform
  const attempt = useRef(0)

  async function connect(connection?: HostConnection) {
    const id = ++attempt.current
    setConnecting(true)
    setError('')
    const config =
      connection ??
      (platform
        ? await platform.getHostConnection()
        : { url: window.location.origin, token: '', hostId: '', local: false })
    const next = new HostClient({
      connection: config,
      platform,
      selectDirectory: (load) =>
        new Promise((resolve) => {
          directoryRef.current?.resolve(null)
          const request = { load, resolve }
          directoryRef.current = request
          setDirectory(request)
        }),
    })
    try {
      await next.bridge.getConnection()
      await next.connect()
      if (attempt.current !== id) {
        next.close()
        return
      }
      clientRef.current?.close()
      clientRef.current = next
      window.piMemeClient = next.bridge
      window.piMemePlugins = next.plugins
      registryRef.current?.close()
      const services = new HostServiceRegistry(next, {
        baseUrl: window.location.origin,
        platform,
        selectDirectory: (load) =>
          new Promise((resolve) => {
            directoryRef.current?.resolve(null)
            const request = { load, resolve }
            directoryRef.current = request
            setDirectory(request)
          }),
      })
      registryRef.current = services
      setRegistry(services)
      setClient(next)
      setToken('')
    } catch (cause) {
      next.close()
      if (attempt.current === id) setError(String(cause))
    } finally {
      if (attempt.current === id) setConnecting(false)
    }
  }

  useEffect(() => {
    void connect().catch((cause: unknown) => {
      setError(String(cause))
      setConnecting(false)
    })
    return () => {
      attempt.current++
      directoryRef.current?.resolve(null)
      registryRef.current?.close()
      clientRef.current?.close()
    }
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    await connect({ url: window.location.origin, token, hostId: '', local: Boolean(platform) })
  }

  const showSplash = splashPhase !== 'done' && (connecting || Boolean(client))

  return (
    <>
      {client && registry ? (
        <ServicesApp registry={registry} nativeWindow={Boolean(platform)} onBootComplete={markBootComplete} />
      ) : !client && !connecting ? (
        <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
          <form
            onSubmit={(event) => void submit(event).catch((cause: unknown) => setError(String(cause)))}
            className="w-full max-w-sm space-y-4 rounded-xl border border-border p-6"
          >
            <h1 className="text-lg font-semibold">登录 Pi meme</h1>
            <label className="block space-y-2 text-sm">
              访问令牌
              <Input
                type="password"
                autoComplete="off"
                aria-label="访问令牌"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive break-words">
                {error}
              </p>
            )}
            <Button className="w-full" disabled={connecting} type="submit">
              {connecting ? '连接中' : '连接'}
            </Button>
            {platform && (
              <Button
                className="w-full"
                variant="outline"
                disabled={connecting}
                type="button"
                onClick={() => void connect().catch((cause: unknown) => setError(String(cause)))}
              >
                重试连接服务
              </Button>
            )}
          </form>
        </main>
      ) : null}
      {showSplash && <StartupSplash exiting={splashPhase === 'exiting'} />}
      {directory && (
        <HostDirectoryDialog
          load={directory.load}
          onSelect={(path) => {
            directory.resolve(path)
            directoryRef.current = undefined
            setDirectory(undefined)
          }}
        />
      )}
    </>
  )
}

declare global {
  interface Window {
    piPlatform?: PlatformAdapter
    piMemeClient?: HostClient['bridge']
    piMemePlugins?: HostClient['plugins']
    piMemeMultiServiceBridges?: Record<string, DesktopBridge>
    piMemeTestBridge?: DesktopBridge
  }
}
