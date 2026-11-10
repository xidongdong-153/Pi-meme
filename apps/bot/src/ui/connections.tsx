import { Activity, useState, ViewTransition } from 'react'
import { Plus } from 'lucide-react'
import type { AppProject } from '@pi-meme/contracts/app-host'
import { request } from '../client/api'
import type { HostConnection, QqConfig } from '../shared/types'
import {
  Button,
  Check,
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
            if (activeTab !== 'hosts')
              motionTransition('bot-tab', () => {
                setVisited((values) => (values.includes('hosts') ? values : [...values, 'hosts']))
                setTab('hosts')
              })
            window.dispatchEvent(new Event('bots:close-list'))
          }}
        >
          Pi meme Host
        </button>
        <button
          className={`category ${activeTab === 'qq' ? 'selected' : ''}`}
          aria-current={activeTab === 'qq' ? 'page' : undefined}
          onClick={() => {
            if (activeTab !== 'qq')
              motionTransition('bot-tab', () => {
                setVisited((values) => (values.includes('qq') ? values : [...values, 'qq']))
                setTab('qq')
              })
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
            <ViewTransition
              default="none"
              enter={{ 'bot-tab': 'fade-in', default: 'none' }}
              update={{ 'bot-tab': 'fade-in', default: 'none' }}
            >
              <section className="editor-page">
                <div className="section-heading">
                  <h1>{tab === 'hosts' ? 'Pi meme Host' : 'QQ 官方机器人'}</h1>
                  {tab === 'hosts' && (
                    <Button variant="outline" onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
                      <Plus size={15} />
                      添加 Host
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
                              disabled={!!action.busy}
                              onClick={() =>
                                void action.run(h.id, () =>
                                  request(`/hosts/${h.id}/check`, { method: 'POST', body: {} }),
                                )
                              }
                            >
                              检查连接
                            </Button>
                            <Button variant="ghost" onClick={() => motionTransition('bot-modal', () => setEditing(h))}>
                              配置与授权
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => motionTransition('bot-modal', () => setDelegating(h))}
                            >
                              委派项目任务
                            </Button>
                            <Button
                              variant="ghost"
                              className="danger"
                              onClick={() => {
                                if (confirm('解除连接只移除 Bots 登记，远端任务不会自动停止。继续？'))
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
                            添加 Host
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
            </ViewTransition>
          </Activity>
        ))}
      {editing !== undefined && (
        <HostEditor
          host={editing ?? undefined}
          close={() => motionTransition('bot-modal', () => setEditing(undefined))}
          refresh={refresh}
        />
      )}
      {delegating && (
        <DelegationForm
          host={delegating}
          snapshot={snapshot}
          refresh={refresh}
          navigate={navigate}
          close={() => motionTransition('bot-modal', () => setDelegating(undefined))}
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
  const [name, setName] = useState(host?.name ?? '')
  const [url, setUrl] = useState(host?.url ?? 'http://127.0.0.1:4140')
  const [token, setToken] = useState('')
  const [projects, setProjects] = useState<AppProject[]>([])
  const [projectIds, setProjectIds] = useState(host?.projectIds ?? [])
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<unknown>()
  return (
    <Modal title={host ? '配置 Host' : '添加 Host'} onClose={close}>
      <Form
        onSubmit={async () => {
          await request(host ? `/hosts/${host.id}` : '/hosts', {
            method: host ? 'PATCH' : 'POST',
            body: { name, url, projectIds, revision: host?.revision, ...(token ? { token } : {}) },
          })
          await refresh()
          close()
        }}
      >
        <Field label="名称">
          <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Host 地址">
          <Input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label={host?.hasCredential ? '新访问令牌（留空保留）' : '访问令牌'}>
          <Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        {host && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => void request<AppProject[]>(`/hosts/${host.id}/projects`).then(setProjects).catch(setError)}
            >
              读取项目
            </Button>
            <Field label="授权项目">
              <div className="choice-list">
                {projects.map((p) => (
                  <Check
                    key={p.projectId}
                    checked={projectIds.includes(p.projectId)}
                    onChange={(checked) =>
                      setProjectIds((values) =>
                        checked ? [...values, p.projectId] : values.filter((id) => id !== p.projectId),
                      )
                    }
                  >
                    {p.name || p.cwd || p.projectId}
                  </Check>
                ))}
                {projectIds
                  .filter((id) => !projects.some((p) => p.projectId === id))
                  .map((id) => (
                    <Check
                      key={id}
                      checked
                      onChange={() => setProjectIds((values) => values.filter((value) => value !== id))}
                    >
                      {id}
                    </Check>
                  ))}
              </div>
            </Field>
            <details>
              <summary>登记 Host 上已有目录</summary>
              <Field label="远端绝对路径">
                <Input value={cwd} onChange={(e) => setCwd(e.target.value)} />
              </Field>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void request<AppProject>(`/hosts/${host.id}/projects`, { method: 'POST', body: { cwd } })
                    .then((project) => setProjects((values) => [...values, project]))
                    .catch(setError)
                }
              >
                登记已有目录
              </Button>
            </details>
          </>
        )}
        <ErrorText error={error} />
      </Form>
    </Modal>
  )
}
function QqSettings({ snapshot, refresh }: { snapshot: PageProps['snapshot']; refresh: () => Promise<void> }) {
  const qq = snapshot.qq
  const [baseRevision, setBaseRevision] = useState(qq.revision)
  const [appId, setAppId] = useState(qq.appId)
  const [secret, setSecret] = useState('')
  const [defaultBotId, setBot] = useState(qq.defaultBotId)
  const [enabled, setEnabled] = useState(qq.enabled)
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
        onSubmit={async () => {
          const saved = await request<QqConfig>('/channels/qq', {
            method: 'PATCH',
            body: { revision: baseRevision, enabled, appId, defaultBotId, ...(secret ? { appSecret: secret } : {}) },
          })
          setBaseRevision(saved.revision)
          setSecret('')
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
          连接 / 重新连接
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void action.run('bind', async () => {
              setBinding(await request('/channels/qq/binding', { method: 'POST', body: {} }))
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
                void action.run('unbind', () => request('/channels/qq/binding', { method: 'DELETE' }))
            }}
          >
            解除绑定
          </Button>
        )}
      </div>
      {binding && (
        <div className="record">
          <p>在 QQ 私聊发送：</p>
          <code>/绑定 {binding.code}</code>
          <p className="muted">有效至 {date(binding.expiresAt)}</p>
        </div>
      )}
      <details className="help-details">
        <summary>QQ 私聊指令</summary>
        <p>
          绑定后通过官方机器人私聊。发送“/角色”查看角色，“/切换 角色名”切换接待角色，“/状态”查看工作，“/停止”请求停止。
        </p>
      </details>
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
            <option value="">选择已授权角色</option>
            {snapshot.bots
              .filter(
                (b) =>
                  b.enabled &&
                  b.capabilities.includes('hosts') &&
                  snapshot.conversations.find((item) => item.id === conversationId)?.memberIds.includes(b.id) &&
                  (b.hostIds.includes(host.id) || b.hostGrants?.some((grant) => grant.hostId === host.id)),
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
          读取授权项目
        </Button>
        <Field label="项目">
          <Select required value={projectId} onChange={setProject}>
            <option value="">选择 Host 项目</option>
            {projects
              .filter((p) => {
                const bot = snapshot.bots.find((item) => item.id === botId)
                return (
                  host.projectIds.includes(p.projectId) &&
                  (bot?.hostIds.includes(host.id) ||
                    bot?.hostGrants?.some((grant) => grant.hostId === host.id && grant.projectId === p.projectId))
                )
              })
              .map((p) => (
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
