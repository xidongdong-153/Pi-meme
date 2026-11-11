import { useEffect, useRef, useState } from 'react'
import { request } from '../client/api'
import type { Bot } from '../shared/types'
import { BotAvatarPicker } from './bot-avatar-picker'
import {
  Button,
  Check,
  CollapsibleSection,
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

type BotEditorProps = PageProps & {
  bot?: Bot
  close: () => void
  created?: (bot: Bot) => void
  onDirtyChange?: (dirty: boolean) => void
  onSavingChange?: (saving: boolean) => void
  onDraftPersistenceChange?: (persisted: boolean) => void
  onSettings?: (tab: string) => void
}

export function BotEditorDialog({
  bot,
  close,
  created,
  inline = false,
  onDirtyChange: notifyDirty,
  onSavingChange: notifySaving,
  ...props
}: PageProps & {
  bot?: Bot
  close: () => void
  created?: (bot: Bot) => void
  inline?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onSavingChange?: (saving: boolean) => void
  onSettings?: (tab: string) => void
}) {
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftPersisted, setDraftPersisted] = useState(true)
  useEffect(() => {
    notifyDirty?.(dirty)
  }, [dirty, notifyDirty])
  useEffect(() => () => notifyDirty?.(false), [notifyDirty])
  useEffect(() => {
    notifySaving?.(saving)
  }, [saving, notifySaving])
  useEffect(() => () => notifySaving?.(false), [notifySaving])
  function requestClose() {
    if (saving) return
    if (
      !dirty ||
      confirm(draftPersisted ? '关闭编辑？未保存的草稿将保留。' : '浏览器无法保存草稿。关闭并放弃未保存的修改？')
    )
      close()
  }
  const editor = (
    <BotEditor
      {...props}
      bot={bot}
      close={close}
      created={created}
      onDirtyChange={setDirty}
      onSavingChange={setSaving}
      onDraftPersistenceChange={setDraftPersisted}
      onSettings={
        props.onSettings
          ? (tab) => {
              if (saving || (dirty && !draftPersisted && !confirm('浏览器无法保存草稿，前往模型设置并放弃当前修改？')))
                return
              props.onSettings?.(tab)
            }
          : undefined
      }
    />
  )
  return inline ? (
    <div className="bot-editor-inline">{editor}</div>
  ) : (
    <Modal title={bot ? '编辑 Bot' : '创建 Bot'} className="bot-editor-dialog" onClose={requestClose}>
      {editor}
    </Modal>
  )
}

export function BotEditor({
  bot,
  snapshot,
  refresh,
  navigate,
  close,
  created,
  onDirtyChange,
  onSavingChange,
  onDraftPersistenceChange,
  onSettings,
}: BotEditorProps) {
  const storageKey = `bots.editor.v1:${bot?.id ?? 'new'}`
  const [stored] = useState<Partial<Bot>>(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<Bot>) : {}
    } catch {
      return {}
    }
  })
  const [baseRevision, setBaseRevision] = useState(stored.revision ?? bot?.revision)
  const clean = useRef(false)
  const [name, setName] = useState(stored.name ?? bot?.name ?? '')
  const [avatar, setAvatar] = useState(typeof stored.avatar === 'string' ? stored.avatar : (bot?.avatar ?? ''))
  const [description, setDescription] = useState(stored.description ?? bot?.description ?? '')
  const [instructions, setInstructions] = useState(stored.instructions ?? bot?.instructions ?? '')
  const [modelId, setModelId] = useState(stored.modelId ?? bot?.modelId ?? '')
  const [enabled, setEnabled] = useState(stored.enabled ?? bot?.enabled ?? true)
  const [runningTasks, setRunningTasks] = useState('finish')
  const [maxToolCalls, setMaxTools] = useState(stored.maxToolCalls ?? bot?.maxToolCalls ?? 32)
  const action = useAction(refresh)
  const [draftError, setDraftError] = useState(false)
  const [dirty, setDirty] = useState(Object.keys(stored).length > 0)
  function markDirty() {
    clean.current = false
    setDirty(true)
  }
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => {
    if (clean.current || !dirty) return
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          name,
          avatar,
          description,
          instructions,
          modelId,
          enabled,
          maxToolCalls,
          revision: baseRevision,
        }),
      )
      setDraftError(false)
      onDraftPersistenceChange?.(true)
    } catch {
      setDraftError(true)
      onDraftPersistenceChange?.(false)
    }
  }, [
    storageKey,
    name,
    avatar,
    description,
    instructions,
    modelId,
    enabled,
    maxToolCalls,
    baseRevision,
    dirty,
    onDraftPersistenceChange,
  ])
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  return (
    <>
      {bot && baseRevision !== bot.revision && (
        <div className="record">
          <p className="error">角色配置已被其他操作更新，本地修改已保留。保存将检查原修订版本。</p>
          <Button
            variant="outline"
            onClick={() => {
              if (!confirm('放弃本地修改并读取当前配置？')) return
              clean.current = true
              sessionStorage.removeItem(storageKey)
              setName(bot.name)
              setAvatar(bot.avatar)
              setDescription(bot.description)
              setInstructions(bot.instructions)
              setModelId(bot.modelId ?? '')
              setEnabled(bot.enabled)
              setMaxTools(bot.maxToolCalls)
              setBaseRevision(bot.revision)
              setDirty(false)
            }}
          >
            重新读取当前配置
          </Button>
        </div>
      )}
      <div
        className="bot-editor-form"
        onChange={(event) => {
          // The project's Select has a native form bridge; only user-facing controls set editor dirty here.
          if (!(event.target instanceof HTMLSelectElement)) markDirty()
        }}
      >
        <Form
          submit={bot ? '保存' : '创建 Bot'}
          onSubmit={async () => {
            const value = {
              name,
              avatar,
              description,
              instructions,
              modelId: modelId || null,
              enabled,
              runningTasks,
              maxToolCalls,
              ...(bot ? { revision: baseRevision } : {}),
            }
            onSavingChange?.(true)
            try {
              const saved = await request<Bot>(bot ? `/bots/${bot.id}` : '/bots', {
                method: bot ? 'PATCH' : 'POST',
                body: value,
              })
              clean.current = true
              try {
                sessionStorage.removeItem(storageKey)
              } catch {
                // Saving to the server succeeded even if browser storage is unavailable.
              }
              setDirty(false)
              setBaseRevision(saved.revision)
              await refresh().catch(() => {})
              created?.(saved)
              close()
            } finally {
              onSavingChange?.(false)
            }
          }}
        >
          <div className="form-grid bot-editor-basics">
            <Field label="名称">
              <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="bot-editor-avatar">
              <BotAvatarPicker
                value={avatar}
                onChange={(value) => {
                  if (value === avatar) return
                  markDirty()
                  setAvatar(value)
                }}
              />
            </div>
          </div>
          <Field label="角色职责">
            <Textarea
              className="instructions"
              required
              maxLength={32000}
              placeholder="例如：帮我梳理需求、安排工作，并跟进结果。"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Field>
          <CollapsibleSection className="bot-editor-advanced" title="角色设置">
            <Field label="对话模型">
              <Select
                value={modelId}
                onChange={(value) => {
                  markDirty()
                  setModelId(value)
                }}
              >
                <option value="">
                  跟随默认模型
                  {snapshot.models.find((model) => model.id === snapshot.modelSettings.defaultModelId)?.name
                    ? ` · ${snapshot.models.find((model) => model.id === snapshot.modelSettings.defaultModelId)!.name}`
                    : ''}
                </option>
                {snapshot.models
                  .filter((m) => m.kind === 'text')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  const effectiveId = modelId || snapshot.modelSettings.defaultModelId
                  if (effectiveId) {
                    try {
                      sessionStorage.setItem('bots.model.focus', effectiveId)
                    } catch {
                      /* The settings list remains usable without focus storage. */
                    }
                  }
                  if (onSettings) onSettings('models')
                  else navigate('settings', 'models')
                }}
              >
                模型设置
              </Button>
            </Field>
            <Field label="简介">
              <Input maxLength={400} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Check checked={enabled} onChange={setEnabled}>
              启用角色
            </Check>
          </CollapsibleSection>
          {!enabled &&
            snapshot.tasks.some(
              (task) => task.botId === bot?.id && ['queued', 'running', 'waiting', 'stopping'].includes(task.status),
            ) && (
              <Field label="进行中的任务">
                <Select
                  value={runningTasks}
                  onChange={(value) => {
                    markDirty()
                    setRunningTasks(value)
                  }}
                >
                  <option value="finish">保留本次任务至结束</option>
                  <option value="stop">停止该角色当前任务</option>
                </Select>
              </Field>
            )}
          <CollapsibleSection className="bot-editor-advanced" title="任务预算">
            <Field label="每次任务工具调用上限">
              <Input
                type="number"
                min={1}
                max={128}
                value={maxToolCalls}
                onChange={(e) => setMaxTools(Number(e.target.value))}
              />
            </Field>
          </CollapsibleSection>
          {dirty && (
            <p className="muted" role="status">
              有未保存修改
            </p>
          )}
        </Form>
      </div>
      <ErrorText error={action.error} />
      {draftError && (
        <p className="error" role="alert">
          浏览器无法保存草稿，关闭前请保存修改。
        </p>
      )}
      {bot && (
        <CollapsibleSection className="more-actions" title="更多操作">
          <Button
            variant="outline"
            onClick={() =>
              void action.run('copy', async () => {
                const copied = await request<Bot>(`/bots/${bot.id}/copy`, {
                  method: 'POST',
                  body: {},
                })
                created?.(copied)
                close()
              })
            }
          >
            复制角色
          </Button>
          <Button
            variant="ghost"
            className="danger"
            onClick={() => {
              if (confirm(`删除 ${bot.name}？关联会话与计划可能需要先处理。`))
                void action.run('delete', async () => {
                  await request(`/bots/${bot.id}?revision=${bot.revision}`, { method: 'DELETE' })
                  close()
                  navigate('chats')
                })
            }}
          >
            删除角色
          </Button>
        </CollapsibleSection>
      )}
    </>
  )
}
