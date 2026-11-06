import {
  contextCaptureLimits,
  type ContextCapture,
  type ContextRuntimeCapture,
} from '@pi-meme/contracts/context-window'
import { inspectPrompt } from '../shared/prompt'

type Context = {
  registerContextCaptureHandler: (handler: (event: ContextRuntimeCapture) => void) => void
  requestContextCapture: (capture: ContextCapture) => Promise<void>
}
type SizedCapture = { capture: ContextCapture; bytes: number }
type PendingRequest = { payload?: SizedCapture; terminal?: SizedCapture }
const maxConcurrent = 4
const maxRequests = 128
const bytesOf = (request?: PendingRequest) => (request?.payload?.bytes ?? 0) + (request?.terminal?.bytes ?? 0)

function dropContent(capture: ContextCapture) {
  if (capture.body !== undefined) {
    delete capture.body
    capture.bodyState = 'missing'
  }
  if (capture.reply !== undefined) {
    delete capture.reply
    capture.replyCut = true
  }
}

function contentBytes(capture: ContextCapture) {
  try {
    return (
      Buffer.byteLength(capture.body ?? '') + (capture.reply ? Buffer.byteLength(JSON.stringify(capture.reply)) : 0)
    )
  } catch {
    dropContent(capture)
    return 0
  }
}

/** Static Worker contribution; does not install tools or append context to the model. */
export function create(context: Context) {
  const queued = new Map<string, PendingRequest>()
  const active = new Map<string, PendingRequest>()
  let retainedBytes = 0
  let warned = false
  const send = async (event: SizedCapture) => {
    try {
      await context.requestContextCapture(event.capture)
    } catch {
      if (!warned) {
        warned = true
        console.error('上下文快照未保存')
      }
    }
  }
  const pump = () => {
    for (const [id, request] of queued) {
      if (active.size >= maxConcurrent) break
      if (active.has(id)) continue
      queued.delete(id)
      active.set(id, request)
      // Each request has one lane: Store receives its latest payload before its terminal.
      void (async () => {
        if (request.payload) await send(request.payload)
        if (request.terminal) await send(request.terminal)
      })().finally(() => {
        retainedBytes -= bytesOf(request)
        active.delete(id)
        pump()
      })
    }
  }
  context.registerContextCaptureHandler((event) => {
    const previous = queued.get(event.id)
    if (!previous && !active.has(event.id) && queued.size + active.size >= maxRequests) return
    const latest =
      previous?.terminal ?? previous?.payload ?? active.get(event.id)?.terminal ?? active.get(event.id)?.payload
    if (
      latest &&
      (event.payloadRevision < latest.capture.payloadRevision ||
        (event.payloadRevision === latest.capture.payloadRevision &&
          latest.capture.phase !== 'payload' &&
          event.phase === 'payload'))
    )
      return
    const capture: ContextCapture = { ...event }
    if (capture.body) {
      try {
        capture.prompt = inspectPrompt(capture.api, capture.body, capture.window)
        if (
          capture.prompt &&
          Buffer.byteLength(JSON.stringify(capture.prompt)) > contextCaptureLimits.summaryRecordBytes
        ) {
          capture.prompt = undefined
          capture.error ??= '上下文摘要超过保留上限'
        }
      } catch {
        capture.bodyState = 'unread'
      }
    }
    // Terminal events carry no repeated body, but must keep any parsed summary when coalesced.
    if (!capture.prompt && event.payloadRevision === latest?.capture.payloadRevision) {
      capture.prompt = latest.capture.prompt
      capture.error ??= latest.capture.error
    }
    const request: PendingRequest =
      latest && event.payloadRevision === latest.capture.payloadRevision ? { ...previous } : {}
    const incoming: SizedCapture = { capture, bytes: contentBytes(capture) }
    if (event.phase === 'payload') request.payload = incoming
    else request.terminal = incoming
    if (retainedBytes - bytesOf(previous) + bytesOf(request) > contextCaptureLimits.retainedBytes) {
      dropContent(capture)
      incoming.bytes = 0
    }
    retainedBytes += bytesOf(request) - bytesOf(previous)
    queued.set(event.id, request)
    pump()
  })
  return []
}
