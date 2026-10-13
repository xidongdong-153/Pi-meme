import type { HostServiceRegistry } from '@pi-meme/client/service-registry'
import type { HostClient } from '@pi-meme/client/host-client'
import type { ReactNode } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { HostService } from '@pi-meme/contracts/host'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import type { useAppSession } from './use-app-session'

export type ServiceController = ReturnType<typeof useAppSession> & { openSettings: () => void }
export type ServiceUI = {
  serviceId: string
  active: boolean
  appearanceBridge: DesktopBridge
  services: HostService[]
  sidebar: ReactNode
  remoteSettings: ReactNode
  onController: (id: string, controller: ServiceController) => void
  onLocation: (serviceId: string, input: SelectWorkspace) => Promise<boolean>
  onSearch: () => void
}

export function serviceAddress(address: string) {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}

export type ServiceRegistry = Pick<
  HostServiceRegistry,
  'localServiceId' | 'list' | 'subscribe' | 'initialize' | 'register' | 'retry' | 'remove' | 'refresh'
> & {
  local: Pick<HostClient, 'bridge'>
  get: (id: string) => Pick<HostClient, 'bridge' | 'host' | 'plugins' | 'rpc' | 'nativePlatformAvailable'>
}
