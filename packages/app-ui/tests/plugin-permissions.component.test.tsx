import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { emptyPluginGrant, type PluginGrantUpdate } from '@pi-meme/plugin-sdk/permissions'
import { PluginPermissions } from '../src/settings/plugin-permissions'

afterEach(cleanup)

function fixture() {
  const plugin: UiPluginDescriptor = {
    id: 'example',
    version: '1.0.0',
    generation: 1,
    enabled: true,
    status: 'active',
    policyHash: 'snapshot-a',
    capabilities: { ui: true, agent: true, server: false, resources: false },
    entries: { agent: { trusted: false, restricted: true } },
    permissions: {
      ui: ['composer.before-send', 'navigation.pages'],
      beforeSend: ['validate'],
      restricted: {
        maxAccess: 'read-only',
        capabilities: ['http.request'],
        network: [{ id: 'search', origin: 'https://search.example.com', methods: ['GET'] }],
      },
    },
    grant: emptyPluginGrant('snapshot-a', 4),
  }
  const setGrant = vi.fn(async (_id: string, update: PluginGrantUpdate) => ({
    ...plugin,
    grant: {
      policyHash: update.policyHash,
      revision: update.expectedRevision + 1,
      trusted: update.trusted,
      ui: update.ui,
      restricted: update.restricted,
      beforeSend: update.beforeSend,
    },
  }))
  const listCredentials = vi.fn(async () => [])
  const setCredential = vi.fn(async () => {})
  const client = { setGrant, listCredentials, setCredential } as unknown as PluginClient
  const changed = vi.fn(async () => {})
  return { plugin, client, setGrant, listCredentials, setCredential, changed }
}

test('授权默认关闭，勾选不隐式保存，保存携带快照和CAS修订', async () => {
  const f = fixture()
  render(<PluginPermissions plugin={f.plugin} client={f.client} onChanged={f.changed} />)
  const trust = screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' })
  expect(trust.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('switch', { name: '允许完全权限任务使用可信 Agent' })).toBeNull()
  fireEvent.click(trust)
  fireEvent.click(screen.getByRole('switch', { name: 'validate' }))
  expect(f.setGrant).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(f.setGrant).toHaveBeenCalledOnce())
  expect(f.setGrant.mock.calls[0]).toEqual([
    'example',
    expect.objectContaining({
      policyHash: 'snapshot-a',
      expectedRevision: 4,
      trusted: { ui: true, server: false, agent: false },
      beforeSend: ['validate'],
    }),
  ])
  await waitFor(() => expect(f.changed).toHaveBeenCalledOnce())
})

test('代码或权限摘要变化不沿用旧信任，仍携带旧记录修订防止覆盖', async () => {
  const f = fixture()
  f.plugin.grant = {
    ...emptyPluginGrant('old-snapshot', 9),
    trusted: { ui: true, server: true, agent: true },
    beforeSend: ['validate'],
  }
  render(<PluginPermissions plugin={f.plugin} client={f.client} onChanged={f.changed} />)
  expect(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }).getAttribute('aria-checked')).toBe(
    'false',
  )
  expect(screen.getByRole('switch', { name: 'validate' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(f.setGrant).toHaveBeenCalledOnce())
  expect(f.setGrant.mock.calls[0][1]).toEqual(
    expect.objectContaining({ policyHash: 'snapshot-a', expectedRevision: 9, beforeSend: [] }),
  )
})

test('网络凭据仅提交给所属插件的指定origin，保存后清除输入明文', async () => {
  const f = fixture()
  render(<PluginPermissions plugin={f.plugin} client={f.client} onChanged={f.changed} />)
  fireEvent.change(screen.getByRole('textbox', { name: '凭据标识' }), { target: { value: 'search-key' } })
  fireEvent.change(screen.getByLabelText('网络密钥'), { target: { value: 'Bearer fake-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: '保存网络凭据' }))
  await waitFor(() =>
    expect(f.setCredential).toHaveBeenCalledWith('example', {
      id: 'search-key',
      origin: 'https://search.example.com',
      header: 'Authorization',
      value: 'Bearer fake-test-key',
    }),
  )
  await waitFor(() => expect((screen.getByLabelText('网络密钥') as HTMLInputElement).value).toBe(''))
  expect(screen.queryByText('Bearer fake-test-key')).toBeNull()
})
