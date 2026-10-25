import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { emptyPluginGrant, type PluginGrantUpdate } from '@pi-meme/plugin-sdk/permissions'
import { PluginPermissions } from '../src/settings/plugin-permissions'
import { PluginPage } from '../src/settings/plugin-page'

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

test('权限保存并刷新修订后保留成功反馈，编辑、切换插件或外部更新时不沿用', async () => {
  const f = fixture()
  let refresh!: (plugin: UiPluginDescriptor) => void
  function Page() {
    const [plugin, setPlugin] = useState(f.plugin)
    refresh = setPlugin
    return (
      <PluginPage
        plugins={[plugin]}
        client={f.client}
        errors={{}}
        selection={{ id: plugin.id, onChange: () => {} }}
        onChanged={async () => {
          const result = f.setGrant.mock.results.at(-1)
          if (result?.type === 'return') setPlugin(await result.value)
        }}
      />
    )
  }
  render(<Page />)
  fireEvent.click(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }))
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(f.setGrant).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByText('权限已保存。')).toBeTruthy())
  expect(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  fireEvent.click(screen.getByRole('switch', { name: '增加左侧入口和业务页面' }))
  expect(screen.queryByText('权限已保存。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(screen.getByText('权限已保存。')).toBeTruthy())
  const saved = await f.setGrant.mock.results.at(-1)!.value
  act(() => refresh({ ...saved, id: 'another-plugin' }))
  expect(screen.queryByText('权限已保存。')).toBeNull()
  act(() => refresh({ ...saved, policyHash: 'snapshot-b' }))
  expect(screen.queryByText('权限已保存。')).toBeNull()
  expect(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }).getAttribute('aria-checked')).toBe(
    'false',
  )
  act(() => refresh({ ...f.plugin, grant: emptyPluginGrant('snapshot-a', 7) }))
  expect(screen.queryByText('权限已保存。')).toBeNull()
  expect(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }).getAttribute('aria-checked')).toBe(
    'false',
  )

  let completeSave!: (plugin: typeof saved) => void
  f.setGrant.mockReturnValueOnce(
    new Promise((resolve) => {
      completeSave = resolve
    }),
  )
  fireEvent.click(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }))
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(f.setGrant).toHaveBeenCalledTimes(3))
  const { expectedRevision, ...grant } = f.setGrant.mock.calls.at(-1)![1]
  const accepted = { ...saved, grant: { ...grant, revision: expectedRevision + 1 } }
  act(() => refresh(accepted))
  fireEvent.click(screen.getByRole('switch', { name: '增加左侧入口和业务页面' }))
  await act(async () => completeSave(accepted))
  expect(screen.queryByText('权限已保存。')).toBeNull()
  expect(screen.getByRole('switch', { name: '增加左侧入口和业务页面' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(screen.getByText('权限已保存。')).toBeTruthy())
  expect(f.setGrant.mock.calls.at(-1)![1]).toMatchObject({ expectedRevision: 8, ui: ['navigation.pages'] })
})

test('保存权限失败时保留待保存选择并显示错误，不报告保存成功', async () => {
  const f = fixture()
  f.setGrant.mockRejectedValueOnce(new Error('policy-changed: 授权修订已变化'))
  render(
    <PluginPage
      plugins={[f.plugin]}
      client={f.client}
      errors={{}}
      selection={{ id: f.plugin.id, onChange: () => {} }}
      onChanged={f.changed}
    />,
  )
  fireEvent.click(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }))
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('授权修订已变化'))
  expect(screen.queryByText('权限已保存。')).toBeNull()
  expect(f.changed).not.toHaveBeenCalled()
  expect(screen.getByRole('switch', { name: '信任插件界面（同源 React 代码）' }).getAttribute('aria-checked')).toBe(
    'true',
  )
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
