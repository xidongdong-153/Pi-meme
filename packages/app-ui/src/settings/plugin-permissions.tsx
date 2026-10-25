import { useEffect, useState } from 'react'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'
import { emptyPluginGrant, type PluginGrant, type PluginUiCapability } from '@pi-meme/plugin-sdk/permissions'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'

const uiLabels: Record<PluginUiCapability, string> = {
  'composer.read': '读取当前可见草稿',
  'composer.write': '修改当前可见草稿',
  'composer.attachments': '向草稿添加附件',
  'composer.submit': '请求发送消息（由宿主确认）',
  'composer.before-send': '注册发送前处理器',
  'messages.read': '读取聊天消息',
  'messages.actions': '为聊天消息增加操作',
  'navigation.pages': '增加左侧入口和业务页面',
  'reactive.read': '订阅会话状态和消息变化',
}
const restrictedLabels = {
  'workspace.read': '读取获准工作区',
  'workspace.write': '修改获准工作区',
  'interaction.request': '向用户提问',
  'http.request': '使用下方授权的 HTTPS 目标',
  'sharedData.read': '读取下方授权的共享 JSON',
}

type Credential = { id: string; origin: string; header: 'Authorization' | 'X-Api-Key' }

function GrantSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span>{label}</span>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  )
}

export function PluginPermissions({
  plugin,
  client,
  onChanged,
  onSaved,
  onEdit,
}: {
  plugin: UiPluginDescriptor
  client: PluginClient
  onChanged: () => Promise<void>
  onSaved?: (plugin: UiPluginDescriptor) => void
  onEdit?: () => void
}) {
  const policyHash = plugin.policyHash ?? ''
  const [grant, setGrant] = useState<PluginGrant>(() =>
    plugin.grant?.policyHash === policyHash
      ? structuredClone(plugin.grant)
      : emptyPluginGrant(policyHash, plugin.grant?.revision ?? 0),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const requested = plugin.permissions
  const network = requested?.restricted?.network ?? []
  const sharedData = requested?.restricted?.sharedData ?? []
  const beforeSend = requested?.beforeSend ?? []
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [credentialId, setCredentialId] = useState('')
  const [credentialOrigin, setCredentialOrigin] = useState(network[0]?.origin ?? '')
  const [credentialHeader, setCredentialHeader] = useState<Credential['header']>('Authorization')
  const [credentialValue, setCredentialValue] = useState('')

  useEffect(() => {
    let current = true
    void client.listCredentials(plugin.id).then(
      (value) => {
        if (current) setCredentials(value)
      },
      (cause) => {
        if (current) setError(`无法读取网络凭据：${String(cause)}`)
      },
    )
    return () => {
      current = false
    }
  }, [client, plugin.id])

  function change(update: (value: PluginGrant) => PluginGrant) {
    setSaved(false)
    onEdit?.()
    setGrant(update)
  }
  function uiCapability(capability: PluginUiCapability, checked: boolean) {
    change((value) => ({
      ...value,
      ui: checked ? [...new Set([...value.ui, capability])] : value.ui.filter((entry) => entry !== capability),
    }))
  }
  async function save() {
    if (saving || !policyHash) return
    setSaving(true)
    setError('')
    try {
      const updated = await client.setGrant(plugin.id, {
        ...grant,
        policyHash,
        expectedRevision: plugin.grant?.revision ?? 0,
      })
      setSaved(true)
      onSaved?.(updated)
      await onChanged()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSaving(false)
    }
  }
  async function saveCredential() {
    if (credentialBusy || !credentialId.trim() || !credentialValue || !credentialOrigin) return
    setCredentialBusy(true)
    setError('')
    try {
      await client.setCredential(plugin.id, {
        id: credentialId.trim(),
        origin: credentialOrigin,
        header: credentialHeader,
        value: credentialValue,
      })
      setCredentialValue('')
      setCredentials(await client.listCredentials(plugin.id))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setCredentialBusy(false)
    }
  }

  return (
    <section aria-label="插件权限" className="space-y-4 rounded-xl border border-border p-4">
      <div>
        <h4 className="text-sm font-medium">权限与信任</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          安装不等于授权。可信界面与后台可执行宿主代码；受限入口另受操作系统沙箱约束。权限只作用于当前服务。
        </p>
      </div>
      {plugin.grant && plugin.grant.policyHash !== policyHash && (
        <p role="status" className="text-sm text-muted-foreground">
          插件代码或权限已变化，请重新确认。
        </p>
      )}
      <div>
        {plugin.capabilities?.ui && (
          <GrantSwitch
            label="信任插件界面（同源 React 代码）"
            checked={grant.trusted.ui}
            disabled={saving}
            onChange={(ui) => change((value) => ({ ...value, trusted: { ...value.trusted, ui } }))}
          />
        )}
        {plugin.entries?.server?.trusted && (
          <GrantSwitch
            label="信任后台服务（完整 Host 权限）"
            checked={grant.trusted.server}
            disabled={saving}
            onChange={(server) => change((value) => ({ ...value, trusted: { ...value.trusted, server } }))}
          />
        )}
        {plugin.entries?.agent?.trusted && (
          <GrantSwitch
            label="允许完全权限任务使用可信 Agent"
            checked={grant.trusted.agent}
            disabled={saving}
            onChange={(agent) => change((value) => ({ ...value, trusted: { ...value.trusted, agent } }))}
          />
        )}
      </div>
      {Boolean(requested?.ui?.length) && (
        <div className="border-t border-border pt-3">
          <h5 className="mb-1 text-xs font-medium text-muted-foreground">界面能力</h5>
          {requested?.ui?.map((capability) => (
            <GrantSwitch
              key={capability}
              label={uiLabels[capability]}
              checked={grant.ui.includes(capability)}
              disabled={saving}
              onChange={(checked) => uiCapability(capability, checked)}
            />
          ))}
        </div>
      )}
      {requested?.restricted && (
        <div className="border-t border-border pt-3">
          <h5 className="mb-1 text-xs font-medium text-muted-foreground">受限执行</h5>
          <p className="mb-2 text-xs text-muted-foreground">
            Plan 始终禁止业务文件写入。网络授权不保证远端没有副作用。
          </p>
          {(requested.restricted.capabilities ?? []).map((capability) => (
            <GrantSwitch
              key={capability}
              label={restrictedLabels[capability]}
              checked={grant.restricted.capabilities?.includes(capability) ?? false}
              disabled={saving}
              onChange={(checked) =>
                change((value) => ({
                  ...value,
                  restricted: {
                    ...value.restricted,
                    ...(capability === 'workspace.write'
                      ? { maxAccess: checked ? ('workspace-write' as const) : ('read-only' as const) }
                      : {}),
                    capabilities: checked
                      ? [...new Set([...(value.restricted.capabilities ?? []), capability])]
                      : value.restricted.capabilities?.filter((entry) => entry !== capability),
                  },
                }))
              }
            />
          ))}
          {network.map((permission) => (
            <GrantSwitch
              key={permission.id}
              label={`${permission.origin} · ${permission.methods.join(', ')}`}
              checked={grant.restricted.network?.some((entry) => entry.id === permission.id) ?? false}
              disabled={saving}
              onChange={(checked) =>
                change((value) => ({
                  ...value,
                  restricted: {
                    ...value.restricted,
                    network: checked
                      ? [...(value.restricted.network ?? []).filter((entry) => entry.id !== permission.id), permission]
                      : value.restricted.network?.filter((entry) => entry.id !== permission.id),
                  },
                }))
              }
            />
          ))}
          {sharedData.map((key) => (
            <GrantSwitch
              key={key}
              label={`读取共享记录：${key}`}
              checked={grant.restricted.sharedData?.includes(key) ?? false}
              disabled={saving}
              onChange={(checked) =>
                change((value) => ({
                  ...value,
                  restricted: {
                    ...value.restricted,
                    sharedData: checked
                      ? [...new Set([...(value.restricted.sharedData ?? []), key])]
                      : value.restricted.sharedData?.filter((entry) => entry !== key),
                  },
                }))
              }
            />
          ))}
        </div>
      )}
      {beforeSend.length > 0 && (
        <div className="border-t border-border pt-3">
          <h5 className="mb-1 text-xs font-medium text-muted-foreground">自动处理发送内容</h5>
          <p className="mb-2 text-xs text-muted-foreground">
            只有这里开启的处理器才会自动修改或阻止发送；错误时不会静默放行。
          </p>
          {beforeSend.map((id) => (
            <GrantSwitch
              key={id}
              label={id}
              checked={grant.beforeSend.includes(id)}
              disabled={saving}
              onChange={(checked) =>
                change((value) => ({
                  ...value,
                  beforeSend: checked
                    ? [...new Set([...value.beforeSend, id])]
                    : value.beforeSend.filter((entry) => entry !== id),
                }))
              }
            />
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && !onSaved && (
        <p role="status" className="text-xs text-muted-foreground">
          权限已保存。
        </p>
      )}
      <Button disabled={saving || !policyHash} onClick={() => void save()}>
        {saving ? '正在保存权限…' : '保存权限'}
      </Button>
      {network.length > 0 && (
        <div className="space-y-3 border-t border-border pt-4">
          <h5 className="text-sm font-medium">网络凭据</h5>
          <p className="text-xs text-muted-foreground">
            受限进程只使用凭据标识，宿主向指定 HTTPS 目标注入密钥。请确认远端不会在响应中回显认证头。Authorization 只填
            token，宿主会添加 Bearer 前缀。
          </p>
          {credentials.map((credential) => (
            <div key={credential.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="break-all">
                {credential.id} · {credential.origin} · {credential.header}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={credentialBusy}
                onClick={() => {
                  setCredentialBusy(true)
                  void client
                    .removeCredential(plugin.id, credential.id)
                    .then(() => client.listCredentials(plugin.id))
                    .then(setCredentials)
                    .catch((cause) => setError(String(cause)))
                    .finally(() => setCredentialBusy(false))
                }}
              >
                删除
              </Button>
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label="凭据标识"
              placeholder="凭据标识，例如 search-api"
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
            />
            <select
              aria-label="凭据目标"
              value={credentialOrigin}
              onChange={(event) => setCredentialOrigin(event.target.value)}
              className="rounded-md border border-input bg-background px-3 text-sm"
            >
              {[...new Set(network.map((entry) => entry.origin))].map((origin) => (
                <option key={origin} value={origin}>
                  {origin}
                </option>
              ))}
            </select>
            <select
              aria-label="凭据请求头"
              value={credentialHeader}
              onChange={(event) => setCredentialHeader(event.target.value as Credential['header'])}
              className="rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="Authorization">Authorization</option>
              <option value="X-Api-Key">X-Api-Key</option>
            </select>
            <Input
              aria-label="网络密钥"
              type="password"
              autoComplete="new-password"
              value={credentialValue}
              onChange={(event) => setCredentialValue(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={credentialBusy || !credentialId.trim() || !credentialValue}
            onClick={() => void saveCredential()}
          >
            {credentialBusy ? '正在保存凭据…' : '保存网络凭据'}
          </Button>
        </div>
      )}
    </section>
  )
}
