import { useRef, useState, ViewTransition } from 'react'
import { motionTransition } from './motion'
import { Download, ImagePlus, Paperclip, Upload } from 'lucide-react'
import { attachmentUrl, request } from '../client/api'
import type { Attachment } from '../shared/types'
import {
  Button,
  Empty,
  ErrorText,
  Field,
  Form,
  Input,
  Modal,
  Select,
  Status,
  Textarea,
  date,
  useAction,
} from './common'
import type { PageProps } from './common'

export function Assets({ snapshot, refresh, navigate }: PageProps) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Attachment>()
  const [generating, setGenerating] = useState(false)
  const [target, setTarget] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const action = useAction(refresh)
  const items = snapshot.attachments.filter(
    (a) => (filter !== 'images' || a.mime.startsWith('image/')) && a.name.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <section className="full-page">
      <div className="section-heading">
        <h1>资料</h1>
        <div className="inline-actions">
          <input
            hidden
            ref={file}
            type="file"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              void action.run('upload', async () => {
                for (const item of files) {
                  const form = new FormData()
                  form.set('file', item)
                  await request('/attachments', { method: 'POST', body: form })
                }
              })
              e.target.value = ''
            }}
          />
          <Button variant="outline" onClick={() => file.current?.click()} disabled={!!action.busy}>
            <Upload size={15} />
            上传
          </Button>
          <Button onClick={() => motionTransition('bot-modal', () => setGenerating(true))}>
            <ImagePlus size={15} />
            生成图片
          </Button>
        </div>
      </div>
      <div className="asset-toolbar">
        <Input
          aria-label="搜索资料"
          placeholder="搜索文件名"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={filter} onChange={setFilter}>
          <option value="all">全部资料</option>
          <option value="images">图片</option>
        </Select>
      </div>
      <ErrorText error={action.error} />
      {items.length ? (
        <div className="asset-grid">
          {items.map((a) => (
            <button
              key={a.id}
              className="asset-item"
              onClick={() => motionTransition('bot-asset', () => setSelected(a))}
            >
              {a.mime.startsWith('image/') ? (
                selected?.id === a.id ? (
                  <img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" />
                ) : (
                  <ViewTransition name={`bot-asset-${a.id}`} default="none" share="morph">
                    <img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" />
                  </ViewTransition>
                )
              ) : (
                <div className="file-preview">
                  <Paperclip size={30} />
                </div>
              )}
              <strong>{a.name}</strong>
              <small>
                {Math.ceil(a.size / 1024)} KB · {date(a.createdAt)}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <Empty>上传文件，或生成第一张图片</Empty>
      )}
      <h2 className="section-label">图片生成记录</h2>
      {snapshot.generations.map((g) => (
        <div className="record" key={g.id}>
          <div className="record-heading">
            <p>{g.prompt}</p>
            <Status value={g.status} />
          </div>
          {g.error && <ErrorText error={g.error} />}
          {g.status === 'unknown' && (
            <Button
              variant="outline"
              disabled={!!action.busy}
              onClick={() => {
                if (!confirm('请先在供应商处核对原请求和账单。再次生成可能重复计费，确认创建新尝试？')) return
                void action.run(g.id, () =>
                  request('/generations', {
                    method: 'POST',
                    body: {
                      conversationId: g.conversationId,
                      prompt: g.prompt,
                      modelId: g.modelId,
                      previousGenerationId: g.id,
                      confirmUnknown: true,
                    },
                  }),
                )
              }}
            >
              确认后重新生成
            </Button>
          )}
          <small className="muted">费用：{g.cost === null ? '未知' : `$${g.cost}`}</small>
        </div>
      ))}
      {selected && (
        <Modal title={selected.name} onClose={() => motionTransition('bot-asset', () => setSelected(undefined))}>
          {selected.mime.startsWith('image/') && (
            <ViewTransition name={`bot-asset-${selected.id}`} default="none" share="morph">
              <img className="image-preview" src={attachmentUrl(selected.id)} alt={selected.name} />
            </ViewTransition>
          )}
          <p className="muted">
            {selected.mime} · {selected.size.toLocaleString()} 字节
          </p>
          <div className="inline-actions">
            <a className="download-link" href={attachmentUrl(selected.id)} download={selected.name}>
              <Download size={14} />
              下载
            </a>
            {selected.conversationId && (
              <Button
                variant="ghost"
                onClick={() => {
                  navigate('chats', selected.conversationId)
                  setSelected(undefined)
                }}
              >
                来源会话
              </Button>
            )}
          </div>
          <ErrorText error={action.error} />
          <Field label="添加到会话草稿">
            <Select value={target} onChange={setTarget}>
              <option value="">选择会话</option>
              {snapshot.conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={!target || !!action.busy}
            onClick={() =>
              void action.run('reuse', async () => {
                const attachment =
                  selected.conversationId === target
                    ? selected
                    : await request<Attachment>(`/attachments/${selected.id}/copy`, {
                        method: 'POST',
                        body: { conversationId: target },
                      })
                const key = `bots.draft.v1:${target}`
                const draft = JSON.parse(sessionStorage.getItem(key) ?? '{"text":"","ids":[]}') as {
                  text: string
                  ids: string[]
                }
                sessionStorage.setItem(
                  key,
                  JSON.stringify({ ...draft, ids: [...new Set([...draft.ids, attachment.id])] }),
                )
                setSelected(undefined)
                navigate('chats', target)
              })
            }
          >
            添加到草稿
          </Button>
        </Modal>
      )}
      {generating && (
        <GenerateImage
          snapshot={snapshot}
          refresh={refresh}
          close={() => motionTransition('bot-modal', () => setGenerating(false))}
        />
      )}
    </section>
  )
}
function GenerateImage({
  snapshot,
  refresh,
  close,
}: {
  snapshot: PageProps['snapshot']
  refresh: () => Promise<void>
  close: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const [conversationId, setConversation] = useState('')
  const [modelId, setModel] = useState(snapshot.models.find((m) => m.kind === 'image')?.id ?? '')
  return (
    <Modal title="生成图片" onClose={close}>
      <Form
        submit="生成图片"
        onSubmit={async () => {
          await request('/generations', { method: 'POST', body: { conversationId, prompt, modelId } })
          await refresh()
          close()
        }}
      >
        <Field label="来源会话">
          <Select value={conversationId} onChange={setConversation} required>
            <option value="">选择会话</option>
            {snapshot.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="图片模型">
          <Select value={modelId} onChange={setModel} required>
            <option value="">选择图片模型</option>
            {snapshot.models
              .filter((m) => m.kind === 'image')
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="提示词">
          <Textarea required maxLength={12000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <p className="muted">生成将调用图片模型并可能产生费用。结果未知时请先核对生成记录。</p>
      </Form>
    </Modal>
  )
}
