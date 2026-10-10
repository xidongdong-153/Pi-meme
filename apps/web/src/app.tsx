import { useEffect, useRef, useState } from 'react'
import { App } from '@pi-meme/app-ui/app'
import { HostDirectoryDialog } from '@pi-meme/app-ui/host-directory-dialog'
import { HostClient } from '@pi-meme/client/host-client'
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
const fixtureDescriptors: Awaited<ReturnType<PluginClient['list']>> = [
  'chat',
  'workspace',
  'git',
  'models',
  'settings',
  'mcp',
  'pi-extensions',
  'history',
  'permissions',
  'resources',
  'codemode',
  'subagents',
  'usage',
].map((name) => ({
  id: `@pi-meme/${name}`,
  version: 'fixture',
  generation: 1,
  ui: `builtin:@pi-meme/${name}`,
  enabled: true,
  status: 'active',
}))
const fixturePlugins: PluginClient = {
  list: async () => fixtureDescriptors,
  installDirectory: fixtureUnavailable,
  installPackage: fixtureUnavailable,
  reload: fixtureUnavailable,
  enable: fixtureUnavailable,
  disable: fixtureUnavailable,
  remove: fixtureUnavailable,
  onChange: () => () => {},
}

export function WebApp() {
  if (new URLSearchParams(window.location.search).get('test-fixture') === 'session-switch' && window.piMemeTestBridge)
    return (
      <App
        bridge={window.piMemeTestBridge}
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
  const [directory, setDirectory] = useState<DirectoryRequest>()
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(true)
  const [token, setToken] = useState('')
  const [url, setUrl] = useState(window.location.origin)
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
      clientRef.current?.close()
    }
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    let address: URL
    try {
      address = new URL(url)
    } catch {
      setError('Host 地址必须是有效的 HTTP 或 HTTPS 地址')
      return
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
    if (
      address.username ||
      address.password ||
      (address.protocol !== 'https:' && !(loopback && address.protocol === 'http:'))
    ) {
      setError('远程 Host 必须使用 HTTPS，地址不能包含账号或凭据')
      return
    }
    if (address.origin !== window.location.origin) {
      if (platform?.setHostConnection) {
        await platform.setHostConnection({ url: address.origin, token })
        return
      }
      window.location.assign(address.origin)
      return
    }
    await connect({ url: address.origin, token, hostId: '', local: false })
  }

  if (!client && connecting)
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground" role="status">
        正在连接 Host
      </main>
    )

  if (!client)
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <form
          onSubmit={(event) => void submit(event).catch((cause: unknown) => setError(String(cause)))}
          className="w-full max-w-sm space-y-4 rounded-xl border border-border p-6"
        >
          <h1 className="text-lg font-semibold">连接 pi-meme Host</h1>
          <label className="block space-y-2 text-sm">
            Host 地址
            <Input aria-label="Host 地址" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="block space-y-2 text-sm">
            访问令牌
            <Input
              type="password"
              autoComplete="off"
              aria-label="Host 访问令牌"
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
              onClick={() => void platform.setHostConnection(null).catch((cause: unknown) => setError(String(cause)))}
            >
              连接本地 Host
            </Button>
          )}
        </form>
      </main>
    )

  return (
    <>
      <App
        key={client.clientId}
        bridge={client.bridge}
        hostId={client.hostId}
        hostAddress={client.hostAddress}
        hostLocal={client.localHost}
        plugins={client.plugins}
        call={(method, args) => client.rpc(method, args)}
        nativeWindow={Boolean(platform)}
        localPlatform={client.nativePlatformAvailable}
        hostConnections={
          platform?.listSavedHostConnections && platform.removeSavedHostConnection
            ? {
                list: platform.listSavedHostConnections,
                remove: platform.removeSavedHostConnection,
                connect: (url) => platform.setHostConnection({ url, token: '' }),
              }
            : undefined
        }
        onHostConnection={() => {
          client.close()
          setClient(undefined)
        }}
      />
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
    piMemeTestBridge?: DesktopBridge
  }
}
