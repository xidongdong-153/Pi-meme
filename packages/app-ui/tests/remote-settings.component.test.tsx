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
    enabled: false,
    phase: 'paused',
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
    setEnabled: vi.fn().mockResolvedValue(profile({ enabled: true, phase: 'connecting' })),
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

test('默认展示 SSH，HTTPS 登记独立保留且不混入 SSH 服务', async () => {
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
  expect(screen.getByRole('tab', { name: 'SSH' }).getAttribute('aria-selected')).toBe('true')
  await waitFor(() => expect(ssh.capabilities).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('tab', { name: 'HTTPS' }))
  expect(screen.getByText('remote.example.test')).toBeTruthy()
  expect(screen.queryByText('ssh-hidden.invalid')).toBeNull()
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

test('批量添加调用自动准备的保存入口；已添加别名禁选，刷新保留选择', async () => {
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
  await waitFor(() => expect(ssh.save).toHaveBeenCalledWith({ name: 'vps', target: 'vps' }))
  expect(ssh.setEnabled).not.toHaveBeenCalled()
  expect(onSaved).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

test('批量保存部分失败保留成功项和失败原因，不重复调用启用', async () => {
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

test('手动添加校验端口，名称留空默认 target，没有 Host 二次配置', async () => {
  const { ssh } = setup()
  render(<SshConnectionDialog ssh={ssh} profiles={[]} onSaved={async () => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '手动添加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 主机名' }), { target: { value: 'dev@linux' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 端口' }), { target: { value: '70000' } })
  expect(screen.queryByLabelText('远端 Host 端口')).toBeNull()
  expect(screen.queryByLabelText('SSH Host 访问令牌')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
  expect(screen.getByText('SSH 端口必须是 1 到 65535 的整数，或留空使用 SSH 配置')).toBeTruthy()
  expect(ssh.save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 端口' }), { target: { value: '2222' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'SSH 身份文件路径' }), { target: { value: '~/.ssh/work' } })
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
  await waitFor(() =>
    expect(ssh.save).toHaveBeenCalledWith({
      id: undefined,
      name: 'dev@linux',
      target: 'dev@linux',
      port: 2222,
      identityFile: '~/.ssh/work',
    }),
  )
  expect(ssh.setEnabled).not.toHaveBeenCalled()
})

test('开关直接启用；后台服务变更刷新准备步骤', async () => {
  const connection = profile()
  const { registry, ssh, publish } = setup([connection])
  render(<RemoteSettings services={[]} registry={registry} onRemove={async () => {}} />)
  await waitFor(() => expect(screen.getByRole('switch', { name: '保持连接 WSL Tailscale' })).toBeTruthy())
  fireEvent.click(screen.getByRole('switch', { name: '保持连接 WSL Tailscale' }))
  await waitFor(() => expect(ssh.setEnabled).toHaveBeenCalledWith(connection.id, true))
  expect(screen.queryByRole('dialog')).toBeNull()
  connection.enabled = true
  connection.phase = 'connecting'
  for (const [step, label] of [
    ['checking', '正在检查远端环境'],
    ['installing', '正在安装远端 Host'],
    ['starting', '正在启动远端 Host'],
    ['authenticating', '正在验证远端连接'],
  ] as const) {
    connection.step = step
    await act(async () => publish())
    await waitFor(() => expect(screen.getByText(`正在连接 · ${label}`)).toBeTruthy())
  }
  expect(ssh.list.mock.calls.length).toBeGreaterThan(1)
})

test('启用时仅允许改名，保存保留原参数且不调用启停', async () => {
  const { ssh } = setup()
  const connection = profile({ enabled: true, phase: 'connected' })
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
    }),
  )
  expect(ssh.setEnabled).not.toHaveBeenCalled()
})

test('启停只禁用触发卡片，不阻塞其他连接', async () => {
  const first = profile({ phase: 'paused' })
  const second = profile({ id: 'b'.repeat(24), name: 'VPS', target: 'vps', phase: 'paused' })
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
  await act(async () => finish(profile({ enabled: true, phase: 'connecting' })))
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
