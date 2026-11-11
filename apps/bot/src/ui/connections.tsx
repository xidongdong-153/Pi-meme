import { Activity, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { AppProject } from '@pi-meme/contracts/app-host'
import { request } from '../client/api'
import type { HostConnection, QqConfig } from '../shared/types'
import {
  Button,
  Check,
  CollapsibleSection,
  date,
  DrawerClose,
  Empty,
  ErrorText,
  Field,
  Form,
  Input,
  Modal,
  Select,
  Status,
  Textarea,
  useAction,
} from './common'
import type { PageProps } from './common'
import { motionTransition } from './motion'

export function Connections({ snapshot, refresh, navigate }: PageProps) {
  const [activeTab, setTab] = useState('hosts')
  const [visited, setVisited] = useState<string[]>(['hosts'])
  const [editing, setEditing] = useState<HostConnection | null | undefined>()
  const [delegating, setDelegating] = useState<HostConnection>()
  const action = useAction(refresh)
  return (
    <div className="settings-page">
      <aside className="list-pane">
        <div className="pane-heading">
          <h1>连接</h1>
          <DrawerClose />
        </div>
        <button
          className={`category ${activeTab === 'hosts' ? 'selected' : ''}`}
          aria-current={activeTab === 'hosts' ? 'page' : undefined}
          onClick={() => {
            if (activeTab !== 'hosts') {
              setVisited((values) => (values.includes('hosts') ? values : [...values, 'hosts']))
              setTab('hosts')
            }
            window.dispatchEvent(new Event('bots:close-list'))
          }}
        >
          Pi meme
        </button>
        <button
          className={`category ${activeTab === 'qq' ? 'selected' : ''}`}
          aria-current={activeTab === 'qq' ? 'page' : undefined}
          onClick={() => {
            if (activeTab !== 'qq') {
              setVisited((values) => (values.includes('qq') ? values : [...values, 'qq']))
              setTab('qq')
            }
            window.dispatchEvent(new Event('bots:close-list'))
          }}
        >
          QQ 官方机器人
        </button>
      </aside>
      {['hosts', 'qq']
        .filter((id) => visited.includes(id))
        .map((tab) => (
          <Activity key={tab} mode={activeTab === tab ? 'visible' : 'hidden'}>
            <section className="editor-page">
              <div className="section-heading">
                <h1>{tab === 'hosts' ? 'Pi meme' : 'QQ 官方机器人'}</h1>
                {tab === 'hosts' && (
                  <Button variant="outline" onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
                    <Plus size={15} />
                    连接 Pi meme
                  </Button>
                )}
              </div>
              <ErrorText error={action.error} />
              {tab === 'hosts' ? (
                <>
                  {snapshot.hosts.length ? (
                    snapshot.hosts.map((h) => (
                      <div className="record" key={h.id}>
                        <div className="record-heading">
                          <div>
                            <h2>{h.name}</h2>
                            <p className="break-word muted">{h.url}</p>
                          </div>
                          <Status value={h.status} />
                        </div>
                        {h.error && <ErrorText error={h.error} />}
                        <small className="muted">上次确认 {date(h.checkedAt)}</small>
                        <div className="inline-actions">
                          <Button
                            variant="outline"
                            disabled={action.busy === h.id}
                            onClick={() =>
                              void action.run(h.id, () => request(`/hosts/${h.id}/check`, { method: 'POST', body: {} }))
                            }
                          >
                            检查连接
                          </Button>
                          <Button variant="ghost" onClick={() => motionTransition('bot-modal', () => setEditing(h))}>
                            编辑连接
                          </Button>
                          <Button variant="ghost" onClick={() => motionTransition('bot-modal', () => setDelegating(h))}>
                            委派项目任务
                          </Button>
                          <Button
                            variant="ghost"
                            className="danger"
                            onClick={() => {
                              if (confirm('解除这条 Pi meme 连接？请先处理进行中的委派任务。'))
                                void action.run(h.id, () =>
                                  request(`/hosts/${h.id}`, { method: 'DELETE', body: { revision: h.revision } }),
                                )
                            }}
                          >
                            解除连接
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <Empty
                      action={
                        <Button onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
                          连接 Pi meme
                        </Button>
                      }
                    >
                      连接本机或远程 Pi meme
                    </Empty>
                  )}
                </>
              ) : (
                <QqSettings snapshot={snapshot} refresh={refresh} />
              )}
            </section>
          </Activity>
        ))}
      {editing !== undefined && (
        <HostEditor host={editing ?? undefined} close={() => setEditing(undefined)} refresh={refresh} />
      )}
      {delegating && (
        <DelegationForm
          host={delegating}
          snapshot={snapshot}
          refresh={refresh}
          navigate={navigate}
          close={() => setDelegating(undefined)}
        />
      )}
    </div>
  )
}
function HostEditor({
  host,
  close,
  refresh,
}: {
  host?: HostConnection
  close: () => void
  refresh: () => Promise<void>
}) {
  const [url, setUrl] = useState(host?.url ?? '')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const dirty = url !== (host?.url ?? '') || Boolean(token)
  return (
    <Modal
      title={host ? '编辑 Pi meme' : '连接 Pi meme'}
      onClose={() => {
        if (!saving && (!dirty || confirm('放弃未保存的连接配置？'))) close()
      }}
    >
      <Form
        submit={host ? '保存并连接' : '连接'}
        onSubmit={async () => {
          setSaving(true)
          try {
            await request(host ? `/hosts/${host.id}` : '/hosts', {
              method: host ? 'PATCH' : 'POST',
              body: { url, revision: host?.revision, ...(token ? { token } : {}) },
            })
            await refresh()
            close()
          } finally {
            setSaving(false)
          }
        }}
      >
        <Field label="URL">
          <Input
            autoFocus
            required
            type="url"
            maxLength={2048}
            placeholder="https://pi.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label={host?.hasCredential ? '新密钥（留空保留）' : '密钥'}>
          <Input
            required={!host?.hasCredential}
            maxLength={8192}
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      </Form>
    </Modal>
  )
}

function QqSettings({ snapshot, refresh }: { snapshot: PageProps['snapshot']; refresh: () => Promise<void> }) {
  const qq = snapshot.qq
  const [baseRevision, setBaseRevision] = useState(qq.revision)
  const [appId, setAppId] = useState(qq.appId)
  const [secret, setSecret] = useState('')
  const [defaultBotId, setBot] = useState(qq.defaultBotId || snapshot.modelSettings.defaultAssistantId || '')
  const [enabled, setEnabled] = useState(qq.appId ? qq.enabled : true)
  const [binding, setBinding] = useState<{ code: string; expiresAt: string }>()
  const action = useAction(refresh)
  return (
    <>
      <div className="record-heading">
        <Status value={qq.status} />
        <span className="muted">{qq.boundUserId ? '已绑定 QQ 用户' : '尚未绑定用户'}</span>
      </div>
      <ErrorText error={qq.error} />
      {baseRevision !== qq.revision && (
        <div className="record">
          <p className="error">QQ 配置已更新，本地编辑已保留。保存会检查开始编辑时的版本。</p>
          <Button
            variant="outline"
            onClick={() => {
              if (!confirm('放弃本地编辑并读取当前 QQ 配置？')) return
              setAppId(qq.appId)
              setSecret('')
              setBot(qq.defaultBotId)
              setEnabled(qq.enabled)
              setBaseRevision(qq.revision)
            }}
          >
            重新读取当前配置
          </Button>
        </div>
      )}
      <Form
        submit="保存并连接"
        onSubmit={async () => {
          const saved = await request<QqConfig>('/channels/qq', {
            method: 'PATCH',
            body: { revision: baseRevision, enabled, appId, defaultBotId, ...(secret ? { appSecret: secret } : {}) },
          })
          setBaseRevision(saved.revision)
          setSecret('')
          if (saved.enabled && saved.status !== 'offline' && !saved.boundUserId) {
            const result = await request<{ code: string; expiresAt: string }>('/channels/qq/binding', {
              method: 'POST',
              body: {},
            })
            setBinding(result)
            const current = await request<QqConfig>('/channels/qq')
            setBaseRevision(current.revision)
          }
          await refresh()
        }}
      >
        <Check checked={enabled} onChange={setEnabled}>
          启用 QQ 官方机器人私聊
        </Check>
        <Field label="AppID">
          <Input required value={appId} onChange={(e) => setAppId(e.target.value)} />
        </Field>
        <Field label={qq.hasCredential ? 'AppSecret（留空保留）' : 'AppSecret'}>
          <Input
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <Field label="默认接待 Bot">
          <Select required value={defaultBotId} onChange={setBot}>
            <option value="">选择角色</option>
            {snapshot.bots
              .filter((b) => b.enabled)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </Select>
        </Field>
      </Form>
      <ErrorText error={action.error} />
      <div className="inline-actions">
        <Button
          variant="outline"
          onClick={() =>
            void action.run('connect', () => request('/channels/qq/connect', { method: 'POST', body: {} }))
          }
        >
          重新连接
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void action.run('bind', async () => {
              setBinding(await request('/channels/qq/binding', { method: 'POST', body: {} }))
              setBaseRevision((await request<QqConfig>('/channels/qq')).revision)
            })
          }
        >
          生成绑定码
        </Button>
        {qq.boundUserId && (
          <Button
            variant="ghost"
            onClick={() => {
              if (confirm('解除当前 QQ 用户绑定？'))
                void action.run('unbind', () =>
                  request<QqConfig>('/channels/qq/binding', { method: 'DELETE', body: { revision: qq.revision } }).then(
                    (value) => setBaseRevision(value.revision),
                  ),
                )
            }}
          >
            解除绑定
          </Button>
        )}
      </div>
      {binding && (
        <div className="record">
          <p>在 QQ 私聊发送绑定指令</p>
          <code>/绑定 {binding.code}</code>
          <p className="muted">有效至 {date(binding.expiresAt)}</p>
        </div>
      )}
      <CollapsibleSection className="help-details" title="QQ 私聊指令">
        <p>
          发送“/角色”查看角色，“/切换 角色名”进入对应主对话，“/状态”查看工作，“/补充
          内容”补充当前任务，“/停止”请求停止。
        </p>
      </CollapsibleSection>
    </>
  )
}
function DelegationForm({
  host,
  snapshot,
  refresh,
  navigate,
  close,
}: PageProps & { host: HostConnection; close: () => void }) {
  const [conversationId, setConversation] = useState('')
  const [botId, setBot] = useState('')
  const [projectId, setProject] = useState('')
  const [projects, setProjects] = useState<AppProject[]>([])
  const [projectError, setProjectError] = useState<unknown>()
  useEffect(() => {
    let current = true
    void request<AppProject[]>(`/hosts/${host.id}/projects`)
      .then((value) => {
        if (current) setProjects(value)
      })
      .catch((cause: unknown) => {
        if (current) setProjectError(cause)
      })
    return () => {
      current = false
    }
  }, [host.id])
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<unknown>()
  return (
    <Modal title={`委派至 ${host.name}`} onClose={close}>
      <Form
        submit="创建项目任务"
        onSubmit={async () => {
          await request('/delegations', {
            method: 'POST',
            body: { conversationId, botId, hostId: host.id, projectId, prompt },
          })
          await refresh()
          navigate('chats', conversationId)
          close()
        }}
      >
        <Field label="来源会话">
          <Select required value={conversationId} onChange={setConversation}>
            <option value="">选择会话</option>
            {snapshot.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="执行 Bot">
          <Select required value={botId} onChange={setBot}>
            <option value="">选择 Bot</option>
            {snapshot.bots
              .filter(
                (b) =>
                  b.enabled &&
                  snapshot.conversations.find((item) => item.id === conversationId)?.memberIds.includes(b.id),
              )
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </Select>
        </Field>
        <Button
          type="button"
          variant="outline"
          onClick={() => void request<AppProject[]>(`/hosts/${host.id}/projects`).then(setProjects).catch(setError)}
        >
          刷新项目
        </Button>
        <ErrorText error={projectError} />
        <Field label="项目">
          <Select required value={projectId} onChange={setProject}>
            <option value="">选择 Pi meme 项目</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name || p.cwd || p.projectId}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="任务内容">
          <Textarea required maxLength={40000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <ErrorText error={error} />
      </Form>
    </Modal>
  )
}
