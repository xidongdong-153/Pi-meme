import { Activity, useEffect, useState, ViewTransition } from 'react'
import { Plus } from 'lucide-react'
import { request } from '../client/api'
import type { Memory } from '../shared/types'
import { ModelSettingsPanel } from './model-settings'
import { MemoryEditor } from './memory-editor'
import { Button, Check, DrawerClose, Empty, ErrorText, Field, Form, Input, Select, Textarea, useAction } from './common'
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
  props: PageProps & {
    activeTab?: string
    onTabChange?: (tab: string) => void
    hideNavigation?: boolean
    onDirtyChange?: (dirty: boolean) => void
    onSavingChange?: (saving: boolean) => void
  },
) {
  const { snapshot, refresh } = props
  const [localTab, setLocalTab] = useState('models')
  const activeTab = props.activeTab ?? localTab
  const setTab = props.onTabChange ?? setLocalTab
  const [visited, setVisited] = useState<string[]>([activeTab])
  useEffect(() => {
    setVisited((values) => (values.includes(activeTab) ? values : [...values, activeTab]))
  }, [activeTab])
  const action = useAction(refresh)
  const [toolsDraft, setToolsDraft] = useState<{ web: boolean; domains: string }>()
  const web = toolsDraft?.web ?? snapshot.settings.webEnabled
  const domains = toolsDraft?.domains ?? snapshot.settings.allowedWebDomains.join('\n')
  const [tokenName, setTokenName] = useState('')
  const [tokenWrite, setTokenWrite] = useState(false)
  const [newToken, setNewToken] = useState('')
  const [modelDirty, setModelDirty] = useState(false)
  const [modelSaving, setModelSaving] = useState(false)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [memorySaving, setMemorySaving] = useState(false)
  const { onDirtyChange, onSavingChange } = props
  useEffect(() => {
    onDirtyChange?.(modelDirty || memoryDirty || Boolean(toolsDraft))
  }, [modelDirty, memoryDirty, toolsDraft, onDirtyChange])
  useEffect(() => {
    onSavingChange?.(modelSaving || memorySaving || Boolean(action.busy))
  }, [modelSaving, memorySaving, action.busy, onSavingChange])
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
                </div>
                <ErrorText error={action.error} />
                {tab === 'models' && (
                  <ModelSettingsPanel {...props} onDirtyChange={setModelDirty} onSavingChange={setModelSaving} />
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
                      setToolsDraft(undefined)
                      await refresh()
                    }}
                  >
                    <Check checked={web} onChange={(value) => setToolsDraft({ web: value, domains })}>
                      启用公开网页内容获取
                    </Check>
                    <Field label="允许的域名（每行一个）" hint="只访问公开页面；需要登录的网站须另行配置相应能力。">
                      <Textarea
                        value={domains}
                        placeholder="example.com"
                        onChange={(e) => setToolsDraft({ web, domains: e.target.value })}
                      />
                    </Field>
                  </Form>
                )}
                {tab === 'tools' && <Explore snapshot={snapshot} />}
                {tab === 'appearance' && (
                  <div className="form">
                    <fieldset>
                      <Field label="主题">
                        <Select
                          value={snapshot.settings.theme}
                          disabled={action.busy === 'theme'}
                          onChange={(theme) =>
                            void action.run('theme', () => request('/settings', { method: 'PATCH', body: { theme } }))
                          }
                        >
                          <option value="system">跟随系统</option>
                          <option value="light">浅色</option>
                          <option value="dark">深色</option>
                        </Select>
                      </Field>
                      <Check
                        checked={snapshot.settings.reducedMotion}
                        onChange={(reducedMotion) =>
                          void action.run('motion', () =>
                            request('/settings', { method: 'PATCH', body: { reducedMotion } }),
                          )
                        }
                      >
                        减少动态效果
                      </Check>
                    </fieldset>
                  </div>
                )}
                {tab === 'memories' && (
                  <Memories {...props} onDirtyChange={setMemoryDirty} onSavingChange={setMemorySaving} />
                )}
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
function Memories({
  snapshot,
  refresh,
  onDirtyChange,
  onSavingChange,
}: PageProps & {
  onDirtyChange: (dirty: boolean) => void
  onSavingChange: (saving: boolean) => void
}) {
  const [editing, setEditing] = useState<Memory | null | undefined>()
  const [selected, setSelected] = useState<string>()
  const item = snapshot.memories.find((m) => m.id === selected)
  const action = useAction(refresh)
  if (editing !== undefined)
    return (
      <MemoryEditor
        item={editing ?? undefined}
        snapshot={snapshot}
        refresh={refresh}
        onDirtyChange={onDirtyChange}
        onSavingChange={onSavingChange}
        close={() => {
          setEditing(undefined)
          onDirtyChange(false)
        }}
      />
    )
  return (
    <>
      <div className="form-actions">
        <Button variant="outline" onClick={() => setEditing(null)}>
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
                <Button variant="ghost" onClick={() => setEditing(item)}>
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
            <option value="">选择 Bot</option>
            {snapshot.bots
              .filter((bot) => bot.enabled)
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
