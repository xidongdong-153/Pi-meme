import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, LoaderCircle, Pencil, Plus, ShieldCheck, X } from 'lucide-react'
import { request, RequestError } from '../client/api'
import type { ModelConfig, ModelProtocol, ModelProvider, ModelService, ModelSettings } from '../shared/types'
import { BrandMark, Button, ErrorText, Field, Form, Input, Select } from './common'
import type { PageProps } from './common'

const providers: Record<ModelProvider, { name: string; url: string; protocol: ModelProtocol; placeholder: string }> = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1', protocol: 'openai-responses', placeholder: 'gpt-4.1' },
  anthropic: {
    name: 'Anthropic',
    url: 'https://api.anthropic.com',
    protocol: 'anthropic-messages',
    placeholder: 'claude-sonnet-4-5',
  },
  google: {
    name: 'Google',
    url: 'https://generativelanguage.googleapis.com',
    protocol: 'google-generative-ai',
    placeholder: 'gemini-2.5-flash',
  },
  'openai-compatible': {
    name: '自定义兼容服务',
    url: '',
    protocol: 'openai-completions',
    placeholder: '服务提供的模型 ID',
  },
}

function verificationLabel(model: ModelConfig) {
  if (model.kind === 'image') return '图片生成'
  return {
    unverified: '尚未验证',
    verified: '已连接',
    unsupported: '能力不满足',
    failed: '验证失败',
    unknown: '结果待确认',
  }[model.verification?.status ?? 'unverified']
}

export function ModelSettingsPanel({
  snapshot,
  refresh,
  onDirtyChange,
  onSavingChange,
}: PageProps & {
  onDirtyChange?: (dirty: boolean) => void
  onSavingChange?: (saving: boolean) => void
}) {
  const settings = snapshot.modelSettings
  const [editor, setEditor] = useState<{
    key: string
    service?: ModelService
    model?: ModelConfig
    connectionOnly?: boolean
    kind?: 'text' | 'image'
  }>()
  const [defaultId, setDefaultId] = useState<string>()
  const [working, setWorking] = useState('')
  const [error, setError] = useState<unknown>()
  const [editorDirty, setEditorDirty] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)
  const pending = useRef(false)
  const dialogueModels = settings.models.filter((model) => model.kind === 'text')
  const currentDefault = settings.models.find((model) => model.id === settings.defaultModelId)
  const defaultDirty = Boolean(defaultId && defaultId !== settings.defaultModelId)
  useEffect(() => {
    onDirtyChange?.(editorDirty || defaultDirty)
  }, [editorDirty, defaultDirty, onDirtyChange])
  useEffect(() => {
    onSavingChange?.(editorSaving || Boolean(working))
  }, [editorSaving, working, onSavingChange])
  useEffect(() => {
    const id = sessionStorage.getItem('bots.model.focus')
    if (!id) return
    const row = document.getElementById(`bot-model-${id}`)
    if (!row) return
    sessionStorage.removeItem('bots.model.focus')
    row.scrollIntoView({ block: 'nearest' })
    row.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [settings.models])
  async function run(id: string, action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setWorking(id)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause)
    } finally {
      pending.current = false
      setWorking('')
    }
  }
  async function check(model: ModelConfig) {
    const result = await request<ModelSettings>('/settings/models/check', {
      method: 'POST',
      body: { modelId: model.id, revision: settings.revision },
    })
    await refresh()
    const checked = result.models.find((item) => item.id === model.id)
    if (checked?.verification?.status !== 'verified')
      throw new Error(checked?.verification?.error ?? '模型尚未通过工具调用验证。请检查配置后重试。')
    return result
  }
  function openEditor(next: NonNullable<typeof editor>) {
    if (editorSaving || (editorDirty && !confirm('切换编辑项并放弃当前未保存的模型配置？'))) return
    setEditorDirty(false)
    setEditor(next)
    setError(undefined)
  }
  function closeEditor() {
    setEditor(undefined)
    setEditorDirty(false)
    setEditorSaving(false)
  }
  function renderModel(model: ModelConfig, service: ModelService) {
    return (
      <div key={model.id} id={`bot-model-${model.id}`} className="model-row-wrap">
        <div className="model-row">
          <div className="model-row-label">
            <strong>{model.name || model.model}</strong>
            <small>
              {model.name !== model.model ? `${model.model} · ` : ''}
              {verificationLabel(model)}
            </small>
          </div>
          {model.id === settings.defaultModelId && <span className="model-default-badge">默认</span>}
          {model.kind === 'text' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={working === model.id}
              onClick={() =>
                void run(model.id, async () => {
                  await check(model)
                })
              }
            >
              {working === model.id ? (
                <LoaderCircle size={14} className="spin" />
              ) : model.verification?.status === 'verified' ? (
                <ShieldCheck size={14} />
              ) : (
                <CircleAlert size={14} />
              )}
              验证
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`编辑 ${model.name || model.model}`}
            onClick={() => openEditor({ key: model.id, model, service })}
          >
            <Pencil size={15} />
          </Button>
        </div>
        {editor?.key === model.id && (
          <ModelConnectionEditor
            key={editor.key}
            settings={settings}
            model={model}
            service={service}
            refresh={refresh}
            close={closeEditor}
            onDirtyChange={setEditorDirty}
            onSavingChange={setEditorSaving}
          />
        )}
      </div>
    )
  }
  return (
    <div className="model-settings">
      <div className="model-default-setting">
        <Field label="默认对话模型" hint="所有跟随默认的 Bot 都使用此模型。需要支持文字、工具调用。">
          <Select value={defaultId || currentDefault?.id || ''} onChange={setDefaultId}>
            <option value="">选择对话模型</option>
            {dialogueModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.model}
              </option>
            ))}
          </Select>
        </Field>
        {defaultId && defaultId !== settings.defaultModelId && (
          <Button
            disabled={working === 'default'}
            onClick={() =>
              void run('default', async () => {
                const model = settings.models.find((item) => item.id === defaultId)
                if (!model) throw new Error('模型已不存在，请刷新后重新选择。')
                const checked = model.verification?.status === 'verified' ? settings : await check(model)
                await request('/settings/models', {
                  method: 'PATCH',
                  body: { revision: checked.revision, defaultModelId: defaultId },
                })
                await refresh()
              })
            }
          >
            {working === 'default' && <LoaderCircle size={14} className="spin" />}设为默认
          </Button>
        )}
      </div>
      <ErrorText error={error} />
      <div className="model-section-heading">
        <h2>模型服务</h2>
        <Button variant="outline" size="sm" onClick={() => openEditor({ key: 'new-service' })}>
          <Plus size={14} />
          添加服务
        </Button>
      </div>
      {editor?.key === 'new-service' && (
        <ModelConnectionEditor
          key={editor.key}
          settings={settings}
          refresh={refresh}
          close={closeEditor}
          onDirtyChange={setEditorDirty}
          onSavingChange={setEditorSaving}
        />
      )}
      {!settings.services.length && !editor && (
        <div className="model-empty">
          <p>连接模型服务后即可选择默认对话模型。</p>
          <Button variant="outline" onClick={() => openEditor({ key: 'new-service' })}>
            <Plus size={15} />
            连接服务
          </Button>
        </div>
      )}
      {settings.services.map((service) => {
        const models = settings.models.filter((model) => model.serviceId === service.id)
        const textModels = models.filter((model) => model.kind === 'text')
        const imageModels = models.filter((model) => model.kind === 'image')
        return (
          <section className="model-service" key={service.id} aria-label={service.name}>
            <div className="model-service-heading">
              <div>
                <h3>{service.name || providers[service.provider].name}</h3>
                <small>
                  {providers[service.provider].name} · {service.hasCredential ? '已配置密钥' : '未配置密钥'}
                </small>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openEditor({ key: `service:${service.id}`, service, connectionOnly: true })}
              >
                连接设置
              </Button>
            </div>
            {editor?.key === `service:${service.id}` && (
              <ModelConnectionEditor
                key={editor.key}
                settings={settings}
                service={service}
                connectionOnly
                refresh={refresh}
                close={closeEditor}
                onDirtyChange={setEditorDirty}
                onSavingChange={setEditorSaving}
              />
            )}
            {textModels.map((model) => renderModel(model, service))}
            {imageModels.length > 0 && (
              <details className="model-image-section">
                <summary>图片生成 · {imageModels.length}</summary>
                {imageModels.map((model) => renderModel(model, service))}
              </details>
            )}
            {editor?.key === `add:${service.id}` ? (
              <ModelConnectionEditor
                key={editor.key}
                settings={settings}
                service={service}
                refresh={refresh}
                close={closeEditor}
                onDirtyChange={setEditorDirty}
                onSavingChange={setEditorSaving}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="model-add"
                onClick={() => openEditor({ key: `add:${service.id}`, service })}
              >
                <Plus size={14} />
                添加模型
              </Button>
            )}
          </section>
        )
      })}
    </div>
  )
}

export function ModelConnectionEditor({
  settings,
  service,
  model,
  connectionOnly = false,
  onboarding = false,
  refresh,
  close,
  onDirtyChange,
  onSavingChange,
}: {
  settings: ModelSettings
  service?: ModelService
  model?: ModelConfig
  connectionOnly?: boolean
  onboarding?: boolean
  refresh: () => Promise<void>
  close?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onSavingChange?: (saving: boolean) => void
}) {
  const [provider, setProvider] = useState<ModelProvider>(service?.provider ?? 'openai')
  const [modelName, setModelName] = useState(model?.model ?? '')
  const [kind, setKind] = useState<'text' | 'image'>(model?.kind ?? 'text')
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? providers[provider].url)
  const [protocol, setProtocol] = useState(service?.protocol ?? providers[provider].protocol)
  const [apiKey, setKey] = useState('')
  const [name, setName] = useState(model?.name ?? (connectionOnly ? (service?.name ?? '') : ''))
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? '')
  const [maxTokens, setMaxTokens] = useState(model?.maxTokens?.toString() ?? '')
  const signature = JSON.stringify({
    provider,
    modelName,
    kind,
    baseUrl,
    protocol,
    apiKey,
    name,
    contextWindow,
    maxTokens,
  })
  const [savedSignature, setSavedSignature] = useState(signature)
  const dirty = signature !== savedSignature
  const [phase, setPhase] = useState('')
  const [error, setError] = useState<unknown>()
  const [ids] = useState(() => ({
    service: service?.id ?? crypto.randomUUID(),
    model: model?.id ?? crypto.randomUUID(),
  }))
  const checkpoint = useRef<{ signature: string; settings: ModelSettings } | undefined>(undefined)
  const latest = useRef(settings)
  if (settings.revision > latest.current.revision) latest.current = settings
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    onSavingChange?.(Boolean(phase))
  }, [phase, onSavingChange])
  function leaveEditor() {
    if (phase || (dirty && !confirm('关闭并放弃未保存的模型配置？'))) return
    close?.()
  }
  const custom = provider === 'openai-compatible'
  let anonymousLocal = false
  try {
    anonymousLocal = custom && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)
  } catch {
    // The URL control will surface an incomplete address before submission.
  }
  return (
    <div className={`model-inline-editor${onboarding ? ' model-onboarding-editor' : ''}`}>
      {close && (
        <Button
          className="model-editor-close"
          variant="ghost"
          size="icon-sm"
          aria-label="收起模型编辑"
          disabled={Boolean(phase)}
          onClick={leaveEditor}
        >
          <X size={15} />
        </Button>
      )}
      <Form
        submit={onboarding ? '连接并开机' : connectionOnly || kind === 'image' ? '保存' : '保存并验证'}
        onCancel={close ? leaveEditor : undefined}
        onSubmit={async () => {
          setError(undefined)
          let result = checkpoint.current?.signature === signature ? checkpoint.current.settings : undefined
          try {
            if (!result) {
              setPhase('保存配置')
              result = await request<ModelSettings>('/settings/models', {
                method: 'PATCH',
                body: {
                  revision: latest.current.revision,
                  services: [
                    {
                      id: ids.service,
                      name: (connectionOnly ? name.trim() : service?.name) || providers[provider].name,
                      provider,
                      protocol,
                      baseUrl,
                      ...(apiKey ? { apiKey } : {}),
                    },
                  ],
                  ...(!connectionOnly
                    ? {
                        models: [
                          {
                            id: ids.model,
                            serviceId: ids.service,
                            kind,
                            model: modelName.trim(),
                            name: name.trim() || modelName.trim().slice(0, 80),
                            ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
                            ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
                          },
                        ],
                      }
                    : {}),
                },
              })
              latest.current = result
              checkpoint.current = { signature, settings: result }
              setSavedSignature(signature)
            }
            if (!connectionOnly && kind === 'text') {
              setPhase('检查模型连接')
              result = await request<ModelSettings>('/settings/models/check', {
                method: 'POST',
                body: { modelId: ids.model, revision: result.revision },
              })
              latest.current = result
              checkpoint.current = { signature, settings: result }
              const verified = result.models.find((item) => item.id === ids.model)
              if (verified?.verification?.status !== 'verified')
                throw new Error(verified?.verification?.error ?? '模型验证未通过。请检查服务地址、模型与密钥后重试。')
            }
            if (onboarding) {
              setPhase('启用默认助理')
              result = await request<ModelSettings>('/settings/models', {
                method: 'PATCH',
                body: { revision: result.revision, defaultModelId: ids.model },
              })
              latest.current = result
            }
            setKey('')
            await refresh()
            close?.()
          } catch (cause) {
            if (cause instanceof RequestError && cause.code === 'revision-conflict') checkpoint.current = undefined
            await refresh().catch(() => {})
            throw cause
          } finally {
            setPhase('')
          }
        }}
      >
        <Field label="模型服务">
          <Select
            value={provider}
            onChange={(value) => {
              const next = value as ModelProvider
              setProvider(next)
              setBaseUrl(providers[next].url)
              setProtocol(providers[next].protocol)
              setKey('')
            }}
            disabled={Boolean(service) && !connectionOnly && !onboarding}
          >
            {Object.entries(providers).map(([value, item]) => (
              <option key={value} value={value}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        {!connectionOnly && (
          <Field label="模型 ID">
            <Input
              required
              maxLength={200}
              placeholder={providers[provider].placeholder}
              autoComplete="off"
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
            />
          </Field>
        )}
        {custom && (
          <Field label="API 地址">
            <Input
              type="url"
              required
              maxLength={2000}
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
        )}
        <Field
          label={service?.hasCredential ? '新密钥（留空保留）' : anonymousLocal ? 'API 密钥（本地可留空）' : 'API 密钥'}
        >
          <Input
            required={!service?.hasCredential && !anonymousLocal}
            type="password"
            autoComplete="new-password"
            maxLength={8000}
            value={apiKey}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        {!onboarding && (
          <details className="model-advanced">
            <summary>高级参数</summary>
            <Field label={connectionOnly ? '服务名称' : '显示名称'}>
              <Input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            {!connectionOnly && (
              <Field label="用途">
                <Select value={kind} disabled={Boolean(model)} onChange={(value) => setKind(value as 'text' | 'image')}>
                  <option value="text">对话</option>
                  <option value="image">图片生成</option>
                </Select>
              </Field>
            )}
            {!custom && (
              <Field label="API 地址">
                <Input type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </Field>
            )}
            {custom && (
              <Field label="协议">
                <Select value={protocol} onChange={(value) => setProtocol(value as ModelProtocol)}>
                  <option value="openai-completions">Chat Completions</option>
                  <option value="openai-responses">Responses</option>
                </Select>
              </Field>
            )}
            {!connectionOnly && (
              <div className="form-grid">
                <Field label="上下文窗口">
                  <Input
                    type="number"
                    min={2048}
                    max={10000000}
                    placeholder="使用模型信息"
                    value={contextWindow}
                    onChange={(event) => setContextWindow(event.target.value)}
                  />
                </Field>
                <Field label="最大输出">
                  <Input
                    type="number"
                    min={128}
                    max={1000000}
                    placeholder="使用模型信息"
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                  />
                </Field>
              </div>
            )}
          </details>
        )}
        {Boolean(phase) && (
          <p className="model-progress" role="status">
            {phase}…
          </p>
        )}
      </Form>
      <ErrorText error={error} />
      {connectionOnly && service?.hasCredential && (
        <Button
          variant="ghost"
          className="danger"
          disabled={Boolean(phase)}
          onClick={() => {
            if (!confirm('撤销此服务密钥？使用它的模型将无法继续请求。')) return
            setPhase('撤销密钥')
            setError(undefined)
            void request<ModelSettings>('/settings/models', {
              method: 'PATCH',
              body: {
                revision: latest.current.revision,
                services: [{ id: service.id, provider: service.provider, apiKey: '' }],
              },
            })
              .then(async (result) => {
                latest.current = result
                await refresh()
                close?.()
              })
              .catch(setError)
              .finally(() => setPhase(''))
          }}
        >
          撤销服务密钥
        </Button>
      )}
      {model && (
        <Button
          variant="ghost"
          className="danger"
          disabled={Boolean(phase)}
          onClick={() => {
            if (!confirm(`删除 ${model.name || model.model}？使用此模型的 Bot 需先切换。`)) return
            setPhase('删除模型')
            setError(undefined)
            void request(`/models/${model.id}?revision=${model.revision}`, { method: 'DELETE' })
              .then(async () => {
                await refresh()
                close?.()
              })
              .catch(setError)
              .finally(() => setPhase(''))
          }}
        >
          删除模型
        </Button>
      )}
    </div>
  )
}

export function ModelOnboarding(props: PageProps) {
  const settings = props.snapshot.modelSettings
  const model =
    settings.models.find((item) => item.id === settings.defaultModelId && item.kind === 'text') ??
    settings.models.find((item) => item.kind === 'text')
  const service = settings.services.find((item) => item.id === model?.serviceId)
  return (
    <main className="model-onboarding">
      <div className="model-onboarding-content">
        <BrandMark />
        <h1>连接你的对话模型</h1>
        <p className="muted">连通模型后，其余配置交给 Bot。</p>
        <ModelConnectionEditor settings={settings} service={service} model={model} onboarding refresh={props.refresh} />
        <div className="model-onboarding-note">
          <CheckCircle2 size={15} />
          <span>密钥仅保存在此 Bot 服务中</span>
        </div>
      </div>
    </main>
  )
}
