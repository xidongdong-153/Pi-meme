import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy } from 'lucide-react'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type {
  ContextBodyState,
  ContextPartKind,
  ContextPiece,
  ContextPromptItem,
  ContextRequest,
  ContextTextItem,
  ContextWindowApi,
} from '@pi-meme/contracts/context-window'
import { DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { fmtK, itemName, partNames } from './layout'

const roles: Record<string, string> = {
  system: '系统提示词',
  user: '你',
  assistant: '助手',
  thinking: '思考',
  call: '工具调用',
  result: '工具结果',
  tool: '工具定义',
  image: '图片',
  sealed: '密封内容',
}
const gone: Record<ContextBodyState, string> = {
  memory: '',
  archive: '',
  off: '此请求的正文已不再保留；仅在运行期间保留最近 10 个请求的正文。',
  missing: '请求归档中没有此请求：可能尚未保存、已被清理或保存失败。',
  cut: '请求归档只保留了开头，无法读取完整内容。',
  unread: '无法读取此请求的正文。',
  'too-large': '此请求超出正文保留大小上限。',
  pending: '正在读取…',
}
export const bodyStateText = (state: ContextBodyState) => gone[state]
export function ItemLabel({ item, kind }: { item: ContextPromptItem; kind: ContextPartKind }) {
  const name = itemName(item)
  const at = kind === 'files' || kind === 'memory' ? name.lastIndexOf('/') : -1
  return (
    <TooltipHint content={name}>
      <span className="ctx-name">
        <b>{at >= 0 ? name.slice(at + 1) : name}</b>
        {at >= 0 ? <small>{name.slice(0, at + 1)}</small> : null}
      </span>
    </TooltipHint>
  )
}
type PieceProps = {
  api: ContextWindowApi
  session: SessionRef
  requestId: string
  payloadRevision: number
  kind: ContextPartKind | 'reply'
  itemId?: string
  pieceIndex: number
  piece: ContextPiece
}
function PieceView({ api, session, requestId, payloadRevision, kind, itemId, pieceIndex, piece }: PieceProps) {
  const [text, setText] = useState('')
  const [next, setNext] = useState<number>()
  const [src, setSrc] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const live = useRef(true)
  const loading = useRef(false)
  const query = { requestId, payloadRevision, kind, itemId, pieceIndex }
  const read = async (offset = 0) => {
    if (loading.current) return
    loading.current = true
    setBusy(true)
    setError('')
    try {
      const page = await api.piece(session, { ...query, offset, limit: 20_000 })
      if (!live.current) return
      if (page.state !== 'memory' && page.state !== 'archive' && !(kind === 'reply' && page.state === 'cut')) {
        setError(bodyStateText(page.state))
        return
      }
      setText((previous) => (offset ? previous + (page.piece?.text ?? '') : (page.piece?.text ?? '')))
      setNext(page.nextOffset)
    } catch (cause) {
      if (live.current) setError(String(cause))
    } finally {
      loading.current = false
      if (live.current) setBusy(false)
    }
  }
  useEffect(() => {
    live.current = true
    if (piece.role === 'image') {
      setBusy(true)
      void api
        .image(session, query)
        .then((page) => {
          if (!live.current) return
          if (page.src && /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Z0-9+/=\s]+$/i.test(page.src)) setSrc(page.src)
          else setError(bodyStateText(page.state) || '这是一张图片，无法在此处显示。')
        })
        .catch((cause) => {
          if (live.current) setError(String(cause))
        })
        .finally(() => {
          if (live.current) setBusy(false)
        })
    } else if (piece.characters || piece.text) void read()
    return () => {
      live.current = false
    }
    // This component is keyed by the request/item/piece identity in the dialog.
  }, [api, session.hostId, session.sessionId, requestId, payloadRevision, kind, itemId, pieceIndex])
  const copy = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      let full = text
      let offset = next
      while (offset !== undefined) {
        const page = await api.piece(session, { ...query, offset, limit: 20_000 })
        if (!live.current) return
        if (page.state !== 'memory' && page.state !== 'archive' && !(kind === 'reply' && page.state === 'cut'))
          throw new Error(bodyStateText(page.state))
        full += page.piece?.text ?? ''
        if (page.nextOffset !== undefined && page.nextOffset <= offset)
          throw new Error('正文分页没有前进，请重新打开后重试。')
        offset = page.nextOffset
      }
      if (!live.current) return
      await navigator.clipboard.writeText(full)
      if (live.current) setCopied(true)
    } catch (cause) {
      if (live.current) setError(`复制失败：${String(cause)}`)
    } finally {
      if (live.current) setBusy(false)
    }
  }
  return (
    <div className="ctx-piece">
      <div className="ctx-piece-head">
        <span className="ctx-role">{roles[piece.role] ?? piece.role}</span>
        {piece.name ? <code className="ctx-piece-name">{piece.name}</code> : null}
        <span className="grow" />
        {piece.characters || text ? (
          <TooltipHint content="复制完整正文">
            <button aria-label="复制完整正文" className="text ctx-copy" onClick={() => void copy()} disabled={busy}>
              <Copy size={12} />
              {copied ? '已复制' : '复制'}
            </button>
          </TooltipHint>
        ) : null}
      </div>
      {piece.size && (piece.role === 'sealed' || (piece.role === 'thinking' && !piece.characters && !piece.text)) ? (
        <div className="ctx-piece-note">由服务商密封，{piece.size.toLocaleString()} 字节：只有服务商可以读取。</div>
      ) : null}
      {piece.role === 'image' && src ? (
        <button
          className={`ctx-pic${imageLoaded ? ' in' : ''}${expanded ? ' open' : ''}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <img
            src={src}
            alt="请求中的图片"
            decoding="async"
            onLoad={() => setImageLoaded(true)}
            onError={() => {
              setSrc('')
              setError('这是一张图片，无法在此处显示。')
            }}
          />
        </button>
      ) : null}
      {text ? (
        <div className="ctx-text-box">
          <pre className="ctx-text">{text}</pre>
          {next !== undefined ? (
            <button className="text ctx-text-more" disabled={busy} onClick={() => void read(next)}>
              显示更多 · 剩余 {Math.max(0, (piece.characters ?? 0) - text.length).toLocaleString()} 个字符
            </button>
          ) : null}
        </div>
      ) : null}
      {busy ? (
        <div className="ctx-view-wait" role="status">
          正在读取…
        </div>
      ) : null}
      {error ? (
        <div className="ctx-view-gone" role="alert">
          {error}
          {piece.role !== 'image' ? (
            <button className="text" disabled={busy} onClick={() => void read(text ? (next ?? 0) : 0)}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {!busy &&
      !error &&
      !text &&
      !src &&
      piece.role !== 'sealed' &&
      piece.role !== 'image' &&
      !(piece.role === 'thinking' && piece.size) ? (
        <div className="ctx-piece-note">空</div>
      ) : null}
    </div>
  )
}
function TextItem({
  api,
  session,
  requestId,
  payloadRevision,
  kind,
  item,
  initialOpen,
}: {
  api: ContextWindowApi
  session: SessionRef
  requestId: string
  payloadRevision: number
  kind: ContextPartKind
  item: ContextTextItem
  initialOpen: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const [pieces, setPieces] = useState<ContextPiece[]>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || pieces) return
    let current = true
    void api
      .item(session, { requestId, payloadRevision, kind, itemId: item.id })
      .then((page) => {
        if (!current) return
        if (page.state !== 'memory' && page.state !== 'archive') {
          setError(bodyStateText(page.state))
          return
        }
        setPieces(page.items.find((one) => one.id === item.id)?.pieces ?? [])
      })
      .catch((cause) => {
        if (current) setError(String(cause))
      })
    return () => {
      current = false
    }
  }, [api, session, requestId, payloadRevision, kind, item.id, open, pieces, retry])
  return (
    <div className={`ctx-vi${open ? ' open' : ''}`}>
      <button className="ctx-vi-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tw">
          <ChevronDown size={10} />
        </span>
        <ItemLabel item={item} kind={kind} />
        {(item.n ?? 0) > 1 ? <span className="ctx-x">×{item.n}</span> : null}
        <span className="ctx-v">{fmtK(item.tokens)}</span>
      </button>
      {open ? (
        <div className="ctx-vi-text">
          {error ? (
            <p className="ctx-view-gone" role="alert">
              {error}
              <button
                className="text"
                onClick={() => {
                  setError('')
                  setRetry(retry + 1)
                }}
              >
                重试
              </button>
            </p>
          ) : pieces ? (
            pieces.length ? (
              pieces.map((piece, index) => (
                <PieceView
                  key={`${item.id}:${index}`}
                  {...{ api, session, requestId, payloadRevision, kind, piece, pieceIndex: index, itemId: item.id }}
                />
              ))
            ) : (
              <div className="ctx-piece-note">空</div>
            )
          ) : (
            <div className="ctx-view-wait" role="status">
              正在读取…
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
export default function ContextTextDialog({
  api,
  session,
  request,
  kind,
  pick,
  onClose,
}: {
  api: ContextWindowApi
  session: SessionRef
  request: ContextRequest
  kind: ContextPartKind
  pick?: ContextPromptItem
  onClose: () => void
  reducedMotion: boolean
}) {
  const payloadRevision = request.payloadRevision ?? Math.floor(request.revision / 1_000_000)
  const [items, setItems] = useState<ContextTextItem[]>([])
  const [offset, setOffset] = useState<number>()
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  const [reply, setReply] = useState(false)
  const [replyPieces, setReplyPieces] = useState<ContextPiece[]>()
  const [cut, setCut] = useState(false)
  const [all, setAll] = useState(!pick || pick.tag === 'more' || pick.tag === 'turns')
  const [retry, setRetry] = useState(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let current = true
    setBusy(true)
    setError('')
    if (reply) {
      void api
        .reply(session, request.id)
        .then((page) => {
          if (!current) return
          if (page.state !== 'memory' && page.state !== 'archive' && page.state !== 'cut') {
            setError(bodyStateText(page.state))
            return
          }
          setReplyPieces(page.pieces)
          setCut(!!page.cut || page.state === 'cut')
          setSource(page.from === 'archive' ? '模型回复，读取自请求归档。' : '模型返回的回复。')
        })
        .catch((cause) => {
          if (current) setError(String(cause))
        })
        .finally(() => {
          if (current) setBusy(false)
        })
    } else {
      void api
        .item(session, {
          requestId: request.id,
          payloadRevision,
          kind,
          offset: 0,
          limit: 100,
          ...(!all && pick ? { itemId: pick.id } : {}),
        })
        .then((page) => {
          if (!current) return
          if (page.state !== 'memory' && page.state !== 'archive') {
            setError(bodyStateText(page.state))
            return
          }
          setItems(page.items)
          setOffset(page.nextOffset)
          setTotal(page.total)
          setSource(
            page.from === 'archive'
              ? '发送的原始内容，读取自请求归档。'
              : `发送的原始内容，仅在内存中保留最近 ${page.kept} 个请求。`,
          )
        })
        .catch((cause) => {
          if (current) setError(String(cause))
        })
        .finally(() => {
          if (current) setBusy(false)
        })
    }
    return () => {
      current = false
    }
  }, [api, session, request.id, payloadRevision, kind, pick, all, reply, retry])
  const more = async () => {
    if (busy || offset === undefined) return
    setBusy(true)
    try {
      const page = await api.item(session, { requestId: request.id, payloadRevision, kind, offset, limit: 100 })
      if (!alive.current) return
      if (page.state !== 'memory' && page.state !== 'archive') {
        setError(bodyStateText(page.state))
        return
      }
      setItems((previous) => [...previous, ...page.items])
      setOffset(page.nextOffset)
    } catch (cause) {
      if (alive.current) setError(String(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <>
      <div className="ehead">
        <i className={`dot k-${kind}`} />
        <DialogTitle>
          {reply ? '回复' : !all && pick ? `${partNames[kind]} · ${itemName(pick)}` : partNames[kind]}
        </DialogTitle>
        <span className="grow" />
        {!reply ? (
          <span className="ctx-view-total">
            {fmtK(
              all
                ? (request.prompt?.parts.find((part) => part.kind === kind)?.tokens ?? 0)
                : items.reduce((sum, item) => sum + item.tokens, 0),
            )}{' '}
            token
          </span>
        ) : null}
      </div>
      <div className="ctx-view-scroll" aria-busy={busy}>
        <div className="ctx-view-body">
          {source && !error ? <p className="ctx-view-note">{source}</p> : null}
          {error ? (
            <p className="ctx-view-gone" role="alert">
              {error}
              <button className="text" onClick={() => setRetry(retry + 1)}>
                重试
              </button>
            </p>
          ) : reply ? (
            replyPieces?.map((piece, index) => (
              <PieceView
                key={`${request.id}:reply:${index}`}
                {...{ api, session, requestId: request.id, payloadRevision, kind: 'reply', piece, pieceIndex: index }}
              />
            ))
          ) : (
            <div className="ctx-vi-list">
              {items.map((item) => (
                <TextItem
                  key={`${request.id}:${kind}:${item.id}`}
                  {...{
                    api,
                    session,
                    requestId: request.id,
                    payloadRevision,
                    kind,
                    item,
                    initialOpen: !all || total === 1,
                  }}
                />
              ))}
            </div>
          )}
          {busy ? (
            <div className="ctx-view-wait" role="status">
              正在读取…
            </div>
          ) : null}
          {!busy && !error && (reply ? replyPieces?.length === 0 : items.length === 0) ? (
            <div className="ctx-empty">没有内容</div>
          ) : null}
          {!reply && offset !== undefined && !error ? (
            <button className="text ctx-text-more" disabled={busy} onClick={() => void more()}>
              再显示 {Math.min(100, Math.max(0, total - items.length))} 项
            </button>
          ) : null}
          {reply && cut ? <p className="ctx-view-note">仅保留了回复的开头。</p> : null}
        </div>
      </div>
      <div className="bar">
        {!all ? (
          <button
            className="text ctx-view-all"
            onClick={() => {
              setAll(true)
              setReply(false)
            }}
          >
            {partNames[kind]}的全部内容
          </button>
        ) : null}
        <button className={`text${reply ? ' on' : ''}`} onClick={() => setReply(!reply)}>
          {reply ? partNames[kind] : '回复'}
        </button>
        <span className="grow" />
        <button className="text primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </>
  )
}
