import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostService } from '@pi-meme/contracts/host'
import type { SshCapabilities, SshConnection, SshConnectionInput } from '@pi-meme/contracts/ssh-connections'
import type { ServiceRegistry } from '../src/shell/service-ui'
import { RemoteSettings } from '../src/shell/remote-settings'
import { SshConnectionDialog } from '../src/shell/ssh-connection-dialog'

afterEach(cleanup)

function profile(overrides: Partial<SshConnection> = {}): SshConnection {
  return {
    id: 'a'.repeat(24),
    name: 'WSL Tailscale',
    target: 'wsl',
    hostPort: 31415,
    hasToken: false,
    enabled: false,
    phase: 'unconfigured',
    ...overrides,
  }
}

function setup(profiles: SshConnection[] = [], capabilities: SshCapabilities = { canManage: true, available: true }) {
  const listeners = new Set<() => void>()
  const ssh = {
    capabilities: vi.fn().mockResolvedValue(capabilities),
    list: vi.fn().mockImplementation(async () => profiles),
    discover: vi.fn().mockResolvedValue([
      { target: 'wsl', source: '~/.ssh/config' },
      { target: 'vps', source: '~/.ssh/config.d/work' },
    ]),
    save: vi.fn().mockImplementation(async (input: SshConnectionInput) => profile(input)),
    setEnabled: vi.fn().mockResolvedValue(profile({ enabled: true, hasToken: true, phase: 'connecting' })),
    retry: vi.fn().mockResolvedValue(profile()),
    remove: vi.fn().mockResolvedValue(undefined),
  }
  const registry = {
    ssh,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    register: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    list: () => [],
  } as unknown as ServiceRegistry
  return { ssh, registry, publish: () => listeners.forEach((listener) => listener()) }
}

function openSsh() {
  fireEvent.click(screen.getByRole('tab', { name: 'SSH' }))
}

test('默认保留 HTTPS 登记，SSH 服务不会混入 HTTPS 列表', async () => {
  const { registry, ssh } = setup()
  const services: HostService[] = [
    {
      id: 'https',
      hostId: 'one',
      address: 'https://remote.example.test',
      local: false,
      status: 'connected',
      projects: [],
    },
    {
      id: 'ssh',
      hostId: 'two',
      address: 'http://ssh-hidden.invalid',
      local: false,
      status: 'connected',
      projects: [],
      transport: 'ssh',
      name: 'WSL',
    },
  ]
  render(<RemoteSettings services={services} registry={registry} onRemove={async () => {}} />)
  expect(screen.getByText('remote.example.test')).toBeTruthy()
  expect(screen.queryByText('ssh-hidden.invalid')).toBeNull()
  expect(ssh.capabilities).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '配置远程服务' }))
  fireEvent.change(screen.getByRole('textbox', { name: '远程服务地址' }), {
    target: { value: 'https://new.example.test' },
  })
  fireEvent.change(screen.getByLabelText('远程访问令牌'), { target: { value: 'token' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  await waitFor(() =>
    expect(registry.register).toHaveBeenCalledWith({ url: 'https://new.example.test', token: 'token' }),
  )
})

test('没有本机管理资格时不读取 SSH 私有资料，只展示已登记服务', async () => {
  const { registry, ssh } = setup([profile()], {
    canManage: false,
    available: true,
    reason: '请从入口 Host 本机页面管理',
  })
  const service: HostService = {
    id: 'registered',
    hostId: 'remote',
    address: 'http://ssh-private.invalid',
    name: '已登记 WSL',
    local: false,
    status: 'connected',
    transport: 'ssh',
    projects: [],
  }
  render(<RemoteSettings services={[service]} registry={registry} onRemove={async () => {}} />)
  openSsh()
  await waitFor(() => expect(screen.getByText('请从入口 Host 本机页面管理')).toBeTruthy())
  expect(ssh.list).not.toHaveBeenCalled()
  expect(ssh.discover).not.toHaveBeenCalled()
  expect(screen.getByText('已登记 WSL')).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.queryByText('ssh-private.invalid')).toBeNull()
})

test('批量添加只保存资料，不启用；已添加别名禁选，刷新保留选择', async () => {
  const { ssh } = setup()
  const onSaved = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<SshConnectionDialog ssh={ssh} profiles={[profile({ target: 'wsl' })]} onSaved={onSaved} onClose={onClose} />)
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择 vps' })).toBeTruthy())
  expect((screen.getByRole('checkbox', { name: '选择 wsl' }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 vps' }))
  fireEvent.click(screen.getByRole('button', { name: '刷新 SSH 配置' }))
  await waitFor(() => expect(ssh.discover).toHaveBeenCalledTimes(2))
  expect((screen.getByRole('checkbox', { name: '选择 vps' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '添加（1）' }))
  await waitFor(() => expect(ssh.save).toHaveBeenCalledWith({ name: 'vps', target: 'vps', hostPort: 31415 }))
  expect(ssh.setEnabled).not.toHaveBeenCalled()
  expect(onSaved).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

test('批量保存部分失败保留成功项和失败原因，不自动连接', async () => {
  const { ssh } = setup()
  ssh.save.mockImplementation(async (input: SshConnectionInput) => {
    if (input.target === 'vps') throw new Error('配置写入失败')
    return profile(input)
  })
  const onClose = vi.fn()
  render(<SshConnectionDialog ssh={ssh} profiles={[]} onSaved={async () => {}} onClose={onClose} />)
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择 vps' })).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 wsl' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 vps' }))
  fireEvent.click(screen.getByRole('button', { name: '添加（2）' }))
  await waitFor(() => expect(screen.getByText('配置写入失败')).toBeTruthy())
  expect((screen.getByRole('checkbox', { name: '选择 wsl' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('checkbox', { name: '选择 vps' }) as HTMLInputElement).checked).toBe(true)
  expect(onClose).not.toHaveBeenCalled()
  expect(ssh.setEnabled).not.toHaveBeenCalled()
})

test('手动添加校验端口与身份文件路径，缺 Host token 仍可保存而不连接', async () => {
  const { ssh } = setup()
  render(<SshConnectionDialog ssh={ssh} profiles={[]} onSaved={async () => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '手动添加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 显示名称' }), { target: { value: 'Linux' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 主机名' }), { target: { value: 'dev@linux' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 端口' }), { target: { value: '70000' } })
  fireEvent.click(screen.getByRole('radio', { name: '指定身份文件' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(screen.getByText('SSH 端口必须是 1 到 65535 的整数，或留空使用 SSH 配置')).toBeTruthy()
  expect(screen.getByText('请填写入口 Host 上的身份文件路径')).toBeTruthy()
  expect(ssh.save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 端口' }), { target: { value: '2222' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 身份文件路径' }), { target: { value: '~/.ssh/work' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(ssh.save).toHaveBeenCalledWith({
      id: undefined,
      name: 'Linux',
      target: 'dev@linux',
      port: 2222,
      identityFile: '~/.ssh/work',
      hostPort: 31415,
    }),
  )
  expect(ssh.setEnabled).not.toHaveBeenCalled()
})

test('缺令牌的开关引导配置 Host；后台服务变更会刷新 profile', async () => {
  const connection = profile()
  const { registry, ssh, publish } = setup([connection])
  render(<RemoteSettings services={[]} registry={registry} onRemove={async () => {}} />)
  openSsh()
  await waitFor(() => expect(screen.getByRole('switch', { name: '保持连接 WSL Tailscale' })).toBeTruthy())
  fireEvent.click(screen.getByRole('switch', { name: '保持连接 WSL Tailscale' }))
  expect(ssh.setEnabled).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByLabelText('SSH Host 访问令牌')).toBeTruthy())
  expect(screen.getByLabelText('SSH Host 访问令牌').closest('details')?.open).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  connection.phase = 'paused'
  connection.hasToken = true
  await act(async () => publish())
  await waitFor(() => expect(screen.getByText('已暂停')).toBeTruthy())
  expect(ssh.list.mock.calls.length).toBeGreaterThan(1)
})

test('启用时仅允许改名，保存保留原参数且不泄露或覆盖令牌', async () => {
  const { ssh } = setup()
  const connection = profile({ enabled: true, hasToken: true, phase: 'connected' })
  render(
    <SshConnectionDialog
      ssh={ssh}
      profiles={[connection]}
      connection={connection}
      onSaved={async () => {}}
      onClose={() => {}}
    />,
  )
  const target = screen.getByRole('textbox', { name: 'SSH 主机名' })
  expect(target.closest('fieldset')?.disabled).toBe(true)
  const name = screen.getByRole('textbox', { name: 'SSH 显示名称' }) as HTMLInputElement
  expect(name.disabled).toBe(false)
  fireEvent.change(name, { target: { value: 'Linux renamed' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(ssh.save).toHaveBeenCalledWith({
      id: connection.id,
      name: 'Linux renamed',
      target: 'wsl',
      port: undefined,
      identityFile: undefined,
      hostPort: 31415,
    }),
  )
  expect(ssh.setEnabled).not.toHaveBeenCalled()
})

test('启停只禁用触发卡片，不阻塞其他连接', async () => {
  const first = profile({ hasToken: true, phase: 'paused' })
  const second = profile({ id: 'b'.repeat(24), name: 'VPS', target: 'vps', hasToken: true, phase: 'paused' })
  const { registry, ssh } = setup([first, second])
  let finish!: (connection: SshConnection) => void
  ssh.setEnabled.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  render(<RemoteSettings services={[]} registry={registry} onRemove={async () => {}} />)
  openSsh()
  await waitFor(() => expect(screen.getByRole('switch', { name: '保持连接 VPS' })).toBeTruthy())
  fireEvent.click(screen.getByRole('switch', { name: '保持连接 WSL Tailscale' }))
  expect((screen.getByRole('switch', { name: '保持连接 WSL Tailscale' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('switch', { name: '保持连接 VPS' }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => finish(profile({ enabled: true, hasToken: true, phase: 'connecting' })))
})

test.each([false, true])('移除已验证=%s 的 SSH 连接使用正确的守卫入口', async (verified) => {
  const connection = profile({ hostId: verified ? 'remote-host' : undefined })
  const { registry, ssh } = setup([connection])
  const onRemove = vi.fn().mockResolvedValue(undefined)
  render(<RemoteSettings services={[]} registry={registry} onRemove={onRemove} />)
  openSsh()
  await waitFor(() => expect(screen.getByRole('button', { name: '管理 WSL Tailscale' })).toBeTruthy())
  fireEvent.keyDown(screen.getByRole('button', { name: '管理 WSL Tailscale' }), { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '移除' })).toBeTruthy())
  fireEvent.click(screen.getByRole('menuitem', { name: '移除' }))
  const dialog = screen.getByRole('dialog', { name: '移除 SSH 连接？' })
  fireEvent.click(within(dialog).getByRole('button', { name: '移除' }))
  await waitFor(() => expect(verified ? onRemove : ssh.remove).toHaveBeenCalledWith(connection.id))
  expect(verified ? ssh.remove : onRemove).not.toHaveBeenCalled()
})
