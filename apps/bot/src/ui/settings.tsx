import { Activity, useEffect, useState, ViewTransition } from 'react'
import { Plus } from 'lucide-react'
import { request } from '../client/api'
import type { Memory, ModelConfig } from '../shared/types'
import {
  Button,
  Check,
  DrawerClose,
  Empty,
  ErrorText,
  Field,
  Form,
  Input,
  Modal,
  Select,
  Textarea,
  useAction,
} from './common'
import type { PageProps } from './common'
import { motionTransition } from './motion'

const settingsTabs = [
  ['models', '模型'],
  ['tools', '联网能力'],
  ['memories', '记忆'],
  ['appearance', '外观'],
  ['tokens', '访问凭据'],
] as const

export function SettingsPage(
  props: PageProps & { activeTab?: string; onTabChange?: (tab: string) => void; hideNavigation?: boolean },
) {
  const { snapshot, refresh } = props
  const [localTab, setLocalTab] = useState('models')
  const activeTab = props.activeTab ?? localTab
  const setTab = props.onTabChange ?? setLocalTab
  const [visited, setVisited] = useState<string[]>([activeTab])
  useEffect(() => {
    setVisited((values) => (values.includes(activeTab) ? values : [...values, activeTab]))
  }, [activeTab])
  const [editing, setEditing] = useState<ModelConfig | null | undefined>()
  const action = useAction(refresh)
  const [web, setWeb] = useState(snapshot.settings.webEnabled)
  const [domains, setDomains] = useState(snapshot.settings.allowedWebDomains.join('\n'))
  const [reduced, setReduced] = useState(snapshot.settings.reducedMotion)
  const [theme, setTheme] = useState(() => {
    try {
      const value = localStorage.getItem('bots.theme.v1')
      return value === 'light' || value === 'dark' ? value : 'system'
    } catch {
      return 'system'
    }
  })
  const [tokenName, setTokenName] = useState('')
  const [tokenWrite, setTokenWrite] = useState(false)
  const [newToken, setNewToken] = useState('')
  return (
    <div className={props.hideNavigation ? 'settings-content' : 'settings-page'}>
      {!props.hideNavigation && (
        <aside className="list-pane">
          <div className="pane-heading">
            <h1>设置</h1>
            <DrawerClose />
          </div>
          {settingsTabs.map(([id, name]) => (
            <button
              key={id}
              className={`category ${activeTab === id ? 'selected' : ''}`}
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => {
                if (activeTab !== id)
                  motionTransition('bot-tab', () => {
                    setVisited((values) => (values.includes(id) ? values : [...values, id]))
                    setTab(id)
                  })
                window.dispatchEvent(new Event('bots:close-list'))
              }}
            >
              {name}
            </button>
          ))}
        </aside>
      )}
      {settingsTabs
        .filter(([id]) => visited.includes(id) || id === activeTab)
        .map(([tab]) => (
          <Activity key={tab} mode={activeTab === tab ? 'visible' : 'hidden'}>
            <ViewTransition
              default="none"
              enter={{ 'bot-tab': 'fade-in', default: 'none' }}
              update={{ 'bot-tab': 'fade-in', default: 'none' }}
            >
              <section className="editor-page">
                <div className="section-heading">
                  <h1>
                    {
                      (
                        {
                          models: '模型',
                          tools: '联网能力',
                          memories: '记忆',
                          appearance: '外观',
                          tokens: '访问凭据',
                        } as Record<string, string>
                      )[tab]
                    }
                  </h1>
                  {tab === 'models' && (
                    <Button variant="outline" onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
                      <Plus size={15} />
                      添加模型
                    </Button>
                  )}
                </div>
                <ErrorText error={action.error} />
                {tab === 'models' && (
                  <>
                    {snapshot.models.length ? (
                      snapshot.models.map((m) => (
                        <div className="record" key={m.id}>
                          <div className="record-heading">
                            <div>
                              <h2>{m.name}</h2>
                              <p className="muted">
                                {m.kind === 'image' ? '图片' : '文本'} · {m.provider} · {m.model}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              onClick={() => motionTransition('bot-modal', () => setEditing(m))}
                            >
                              编辑
                            </Button>
                          </div>
                          <p className="muted">{m.hasCredential ? '已配置密钥' : '尚未配置密钥'}</p>
                        </div>
                      ))
                    ) : (
                      <Empty
                        action={
                          <Button onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
                            添加文本模型
                          </Button>
                        }
                      >
                        独立配置模型后即可聊天
                      </Empty>
                    )}
                  </>
                )}
                {tab === 'tools' && (
                  <Form
                    onSubmit={async () => {
                      await request('/settings', {
                        method: 'PATCH',
                        body: {
                          webEnabled: web,
                          allowedWebDomains: domains
                            .split('\n')
                            .map((d) => d.trim())
                            .filter(Boolean),
                        },
                      })
                      await refresh()
                    }}
                  >
                    <Check checked={web} onChange={setWeb}>
                      启用公开网页内容获取
                    </Check>
                    <Field label="允许的域名（每行一个）" hint="只访问公开页面；需要登录的网站须另行配置相应能力。">
                      <Textarea
                        value={domains}
                        placeholder="example.com"
                        onChange={(e) => setDomains(e.target.value)}
                      />
                    </Field>
                    {Object.entries(snapshot.capabilities).map(([name, state]) => (
                      <p className="capability-row" key={name}>
                        <span>{name}</span>
                        <span className="muted">{state.available ? '可用' : (state.reason ?? '不可用')}</span>
                      </p>
                    ))}
                  </Form>
                )}
                {tab === 'tools' && <Explore snapshot={snapshot} />}
                {tab === 'appearance' && (
                  <>
                    <Field label="主题">
                      <Select
                        value={theme}
                        onChange={(value) => {
                          localStorage.setItem('bots.theme.v1', value)
                          setTheme(value)
                          window.dispatchEvent(new Event('bots:theme'))
                        }}
                      >
                        <option value="system">跟随系统</option>
                        <option value="light">浅色</option>
                        <option value="dark">深色</option>
                      </Select>
                    </Field>
                    <Form
                      onSubmit={async () => {
                        await request('/settings', {
                          method: 'PATCH',
                          body: { reducedMotion: reduced },
                        })
                        await refresh()
                      }}
                    >
                      <Check
                        checked={reduced}
                        onChange={(value) => {
                          setReduced(value)
                          document.documentElement.dataset.reducedMotion = String(value)
                        }}
                      >
                        减少动态效果
                      </Check>
                    </Form>
                  </>
                )}
                {tab === 'memories' && <Memories {...props} />}
                {tab === 'tokens' && (
                  <>
                    <PasswordForm />
                    <h2 className="section-label">API 令牌</h2>
                    <Form
                      submit="创建访问令牌"
                      onSubmit={async () => {
                        const result = await request<{ token: string }>('/tokens', {
                          method: 'POST',
                          body: { name: tokenName, scopes: tokenWrite ? ['read', 'write'] : ['read'] },
                        })
                        setNewToken(result.token)
                        setTokenName('')
                        await refresh()
                      }}
                    >
                      <Field label="名称">
                        <Input
                          required
                          maxLength={80}
                          value={tokenName}
                          onChange={(e) => setTokenName(e.target.value)}
                        />
                      </Field>
                      <Check checked={tokenWrite} onChange={setTokenWrite}>
                        允许写操作
                      </Check>
                    </Form>
                    {newToken && (
                      <div className="record">
                        <p>令牌仅显示一次，请保存。</p>
                        <code className="secret-token">{newToken}</code>
                        <Button
                          variant="outline"
                          onClick={() => void action.run('copy-token', () => navigator.clipboard.writeText(newToken))}
                        >
                          复制
                        </Button>
                        <Button variant="ghost" onClick={() => setNewToken('')}>
                          隐藏
                        </Button>
                      </div>
                    )}
                    {snapshot.tokens.map((token) => (
                      <div className="record-heading record" key={token.id}>
                        <div>
                          <h2>{token.name}</h2>
                          <code>{token.prefix}…</code>
                          <small className="muted">
                            {' '}
                            {token.scopes.join(' / ')}
                            {token.revokedAt ? ' · 已撤销' : ''}
                          </small>
                        </div>
                        {!token.revokedAt && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              if (confirm(`撤销 ${token.name}？`))
                                void action.run(token.id, () => request(`/tokens/${token.id}`, { method: 'DELETE' }))
                            }}
                          >
                            撤销
                          </Button>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </section>
            </ViewTransition>
          </Activity>
        ))}
      {editing !== undefined && (
        <ModelEditor
          model={editing ?? undefined}
          close={() => motionTransition('bot-modal', () => setEditing(undefined))}
          refresh={refresh}
        />
      )}
    </div>
  )
}
function PasswordForm() {
  const [currentPassword, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState(false)
  return (
    <details className="help-details">
      <summary>修改访问密码</summary>
      <Form
        submit="更新密码并撤销其他登录"
        onSubmit={async () => {
          await request('/api/auth/password', { method: 'POST', body: { currentPassword, password } })
          setCurrent('')
          setPassword('')
          setSaved(true)
        }}
      >
        <Field label="当前密码">
          <Input
            required
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrent(event.target.value)
              setSaved(false)
            }}
          />
        </Field>
        <Field label="新密码">
          <Input
            required
            type="password"
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setSaved(false)
            }}
          />
        </Field>
      </Form>
      {saved && <p role="status">访问密码已更新，其他登录已撤销。</p>}
    </details>
  )
}
function ModelEditor({
  model,
  close,
  refresh,
}: {
  model?: ModelConfig
  close: () => void
  refresh: () => Promise<void>
}) {
  const [name, setName] = useState(model?.name ?? '')
  const [kind, setKind] = useState(model?.kind ?? 'text')
  const [provider, setProvider] = useState(model?.provider ?? 'openai-compatible')
  const [modelName, setModel] = useState(model?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? 'https://api.openai.com/v1')
  const [apiKey, setKey] = useState('')
  const action = useAction(refresh)
  return (
    <Modal title={model ? '编辑模型' : '添加模型'} onClose={close}>
      <Form
        onSubmit={async () => {
          await request('/settings/models', {
            method: 'PATCH',
            body: {
              models: [
                {
                  id: model?.id,
                  revision: model?.revision,
                  name,
                  kind,
                  provider,
                  model: modelName,
                  baseUrl,
                  ...(apiKey ? { apiKey } : {}),
                },
              ],
            },
          })
          await refresh()
          close()
        }}
      >
        <Field label="名称">
          <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="类型">
            <Select value={kind} onChange={(v) => setKind(v as ModelConfig['kind'])}>
              <option value="text">文本模型</option>
              <option value="image">图片模型</option>
            </Select>
          </Field>
          <Field label="供应商">
            <Select value={provider} onChange={(v) => setProvider(v as ModelConfig['provider'])}>
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
            </Select>
          </Field>
        </div>
        <Field label="模型 ID">
          <Input required value={modelName} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <Field label="API 地址">
          <Input type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label={model?.hasCredential ? '新密钥（留空保留）' : 'API 密钥'}>
          <Input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setKey(e.target.value)} />
        </Field>
      </Form>
      <ErrorText error={action.error} />
      {model && (
        <Button
          variant="ghost"
          className="danger"
          disabled={!!action.busy}
          onClick={() => {
            if (confirm('删除此模型？'))
              void action.run('delete-model', async () => {
                await request(`/models/${model.id}?revision=${model.revision}`, { method: 'DELETE' })
                close()
              })
          }}
        >
          删除模型
        </Button>
      )}
    </Modal>
  )
}
function Memories({ snapshot, refresh }: PageProps) {
  const [editing, setEditing] = useState<Memory | null | undefined>()
  const [selected, setSelected] = useState<string>()
  const item = snapshot.memories.find((m) => m.id === selected)
  const action = useAction(refresh)
  return (
    <>
      <div className="form-actions">
        <Button variant="outline" onClick={() => motionTransition('bot-modal', () => setEditing(null))}>
          <Plus size={15} />
          新增记忆
        </Button>
      </div>
      <div className="memory-layout">
        <div>
          {snapshot.memories.map((m) => (
            <button
              className={`memory-item ${m.id === selected ? 'selected' : ''}`}
              key={m.id}
              onClick={() => setSelected(m.id)}
            >
              <strong>{m.title}</strong>
              <small>{m.scope === 'owner' ? '个人' : m.scope === 'bot' ? 'Bot' : '会话'}</small>
            </button>
          ))}
        </div>
        <div>
          {item ? (
            <>
              <div className="record-heading">
                <h2>{item.title}</h2>
                <Button variant="ghost" onClick={() => motionTransition('bot-modal', () => setEditing(item))}>
                  编辑
                </Button>
              </div>
              <p className="memory-content">{item.content}</p>
              {item.sourceMessageId && (
                <details>
                  <summary>来源</summary>
                  <p>{item.sourceMessageId}</p>
                </details>
              )}
              <details className="more-actions">
                <summary>更多操作</summary>
                <Button
                  variant="ghost"
                  className="danger"
                  onClick={() => {
                    if (confirm('删除此记忆？'))
                      void action.run(item.id, () =>
                        request(`/memories/${item.id}?revision=${item.revision}`, { method: 'DELETE' }),
                      )
                  }}
                >
                  删除记忆
                </Button>
              </details>
            </>
          ) : (
            <Empty>选择一条记忆</Empty>
          )}
        </div>
      </div>
      <ErrorText error={action.error} />
      {editing !== undefined && (
        <MemoryEditor
          item={editing ?? undefined}
          snapshot={snapshot}
          close={() => motionTransition('bot-modal', () => setEditing(undefined))}
          refresh={refresh}
        />
      )}
    </>
  )
}
function Explore({ snapshot }: { snapshot: PageProps['snapshot'] }) {
  const [url, setUrl] = useState('')
  const [botId, setBot] = useState('')
  const [content, setContent] = useState('')
  return (
    <div className="record">
      <h2 className="section-label">探索公开网页</h2>
      <Form
        submit="获取网页内容"
        onSubmit={async () => {
          const result = await request<{ content: string }>('/explore', { method: 'POST', body: { url, botId } })
          setContent(result.content)
        }}
      >
        <Field label="执行 Bot">
          <Select required value={botId} onChange={setBot}>
            <option value="">选择获授权的角色</option>
            {snapshot.bots
              .filter((bot) => bot.enabled && bot.capabilities.includes('web'))
              .map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="网页地址">
          <Input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
      </Form>
      {content && <p className="memory-content">{content}</p>}
    </div>
  )
}
function MemoryEditor({
  item,
  snapshot,
  close,
  refresh,
}: {
  item?: Memory
  snapshot: PageProps['snapshot']
  close: () => void
  refresh: () => Promise<void>
}) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [content, setContent] = useState(item?.content ?? '')
  const [scope, setScope] = useState(item?.scope ?? 'owner')
  const [target, setTarget] = useState(item?.targetId ?? '')
  return (
    <Modal title={item ? '编辑记忆' : '新增记忆'} onClose={close}>
      <Form
        onSubmit={async () => {
          await request(item ? `/memories/${item.id}` : '/memories', {
            method: item ? 'PATCH' : 'POST',
            body: { revision: item?.revision, title, content, scope, targetId: scope === 'owner' ? undefined : target },
          })
          await refresh()
          close()
        }}
      >
        <Field label="标题">
          <Input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="范围">
          <Select
            value={scope}
            onChange={(v) => {
              setScope(v as Memory['scope'])
              setTarget('')
            }}
          >
            <option value="owner">个人共享</option>
            <option value="bot">Bot 专属</option>
            <option value="conversation">会话</option>
          </Select>
        </Field>
        {scope !== 'owner' && (
          <Field label="所属对象">
            <Select value={target} onChange={setTarget} required>
              <option value="">请选择</option>
              {(scope === 'bot' ? snapshot.bots : snapshot.conversations).map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="内容">
          <Textarea required maxLength={16000} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  )
}
