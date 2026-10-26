import type { HostServiceRegistry } from '@pi-meme/client/service-registry'
import type { HostClient } from '@pi-meme/client/host-client'
import type { ReactNode } from 'react'
import type { DesktopBridge } from '@pi-meme/contracts/desktop'
import type { HostService } from '@pi-meme/contracts/host'
import type { SshConnectionPhase, SshConnectionStep } from '@pi-meme/contracts/ssh-connections'
import type { SelectWorkspace } from '@pi-meme/contracts/sessions'
import type { useAppSession } from '../session/use-app-session'

export type ServiceController = ReturnType<typeof useAppSession> & {
  openSettings: () => void
  openSchedules: () => void
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
  onNavigate: (work: () => Promise<boolean>) => Promise<boolean>
  onSearch: () => void
  onSchedules: (serviceId: string) => void
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

const sshPhaseLabels: Record<SshConnectionPhase, string> = {
  paused: '已暂停',
  connecting: '正在连接',
  connected: '已连接',
  retrying: '正在重连',
  'action-required': '需要处理',
}

const sshStepLabels: Record<SshConnectionStep, string> = {
  checking: '正在检查远端环境',
  installing: '正在安装远端 Host',
  starting: '正在启动远端 Host',
  authenticating: '正在验证远端连接',
}

export function sshConnectionStatus(connection: { phase: SshConnectionPhase; step?: SshConnectionStep }) {
  const phase = sshPhaseLabels[connection.phase]
  return connection.step && (connection.phase === 'connecting' || connection.phase === 'retrying')
    ? `${phase} · ${sshStepLabels[connection.step]}`
    : phase
}

export function serviceStatus(service: HostService) {
  if (service.transport === 'ssh') {
    if (service.enabled === false) return '已暂停'
    if (service.phase) return sshConnectionStatus({ phase: service.phase, step: service.step })
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
