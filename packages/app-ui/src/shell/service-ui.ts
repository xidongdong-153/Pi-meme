import type { HostServiceRegistry } from '@pi-meme/client/service-registry'
import type { HostClient } from '@pi-meme/client/host-client'
import type { ReactNode } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { HostService } from '@pi-meme/contracts/host'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import type { useAppSession } from '../session/use-app-session'

export type ServiceController = ReturnType<typeof useAppSession> & {
  openSettings: () => void
  assertRestartAllowed: () => void
  assertRemoveAllowed?: () => void
  openProjectDialog?: () => void
  beforeDeactivate?: () => Promise<boolean>
}
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
  beforeRestart: () => void
}

export function serviceAddress(address: string) {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}

export function serviceLabel(service: Pick<HostService, 'name' | 'local' | 'address'>) {
  return service.local ? '此计算机' : service.name || serviceAddress(service.address)
}

export function serviceStatus(service: HostService) {
  if (service.transport === 'ssh') {
    if (service.enabled === false) return '已暂停'
    if (service.phase === 'action-required') return '需要处理'
    if (service.phase === 'retrying') return '正在重连'
  }
  return service.status === 'connected' ? '已连接' : service.status === 'connecting' ? '连接中' : '未连接'
}

export function servicePaused(service: HostService) {
  return service.transport === 'ssh' && service.enabled === false
}

export type ServiceRegistry = Pick<
  HostServiceRegistry,
  'localServiceId' | 'list' | 'subscribe' | 'initialize' | 'register' | 'retry' | 'remove' | 'refresh' | 'ssh'
> & {
  local: Pick<HostClient, 'bridge'>
  get: (id: string) => Pick<HostClient, 'bridge' | 'host' | 'plugins' | 'rpc' | 'nativePlatformAvailable'>
}
