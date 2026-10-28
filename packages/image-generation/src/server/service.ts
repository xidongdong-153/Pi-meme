import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { maxImagePreviewBytes } from '@pi-meme/contracts/app-host'
import { MAX_CHAT_ATTACHMENT_BYTES } from '@pi-meme/contracts/chat-attachments'
import type { ImageGenerationResult, ImageGenInput, ImageSource } from '@pi-meme/contracts/image-generation'
import { validateImageInput } from '../shared/input'
import type { ImageConfigStore } from './config-store'
import { downloadImage, readResponse } from './download'

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function imageMime(bytes: Buffer) {
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(pngSignature) && bytes.toString('ascii', 12, 16) === 'IHDR')
    return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('图片格式无效，仅支持 PNG、JPEG 和 WebP')
}
function base64Bytes(value: string) {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error('图片服务返回了无效的 Base64 图片')
  return Buffer.from(value, 'base64')
}
export type ImageExecution = {
  cwd: string
  signal: AbortSignal
  destinationDirectory?: string
  assertActive?: () => void
}

export class ImageGenerationService {
  private readonly pending = new Set<AbortController>()
  constructor(
    readonly config: ImageConfigStore,
    private readonly save: (
      name: string,
      bytes: Buffer,
      signal: AbortSignal,
      destinationDirectory?: string,
    ) => Promise<{ path: string }>,
  ) {}

  dispose() {
    for (const controller of this.pending) controller.abort()
  }

  async ready() {
    try {
      await this.config.selected()
      return true
    } catch {
      return false
    }
  }

  async generate(
    input: ImageGenInput,
    sources: ImageSource[],
    execution: ImageExecution,
    modelId?: string,
  ): Promise<ImageGenerationResult> {
    validateImageInput(input)
    const expected = input.referenced_image_paths?.length ?? input.num_last_images_to_include ?? 0
    if (sources.length !== expected || sources.length > 5) throw new Error('图片引用数量与请求不一致')
    const model = await this.config.selected(modelId)
    const timeout = AbortSignal.timeout(5 * 60 * 1000)
    const controller = new AbortController()
    this.pending.add(controller)
    const signal = AbortSignal.any([execution.signal, timeout, controller.signal])
    const assertActive = () => {
      signal.throwIfAborted()
      execution.assertActive?.()
    }
    try {
      assertActive()
      let total = 0
      const images: Array<{ bytes: Buffer; mime: string }> = []
      for (const source of sources) {
        let bytes: Buffer
        if (source.path) {
          const file = await open(path.resolve(execution.cwd, source.path), constants.O_RDONLY | constants.O_NONBLOCK)
          try {
            const info = await file.stat()
            if (!info.isFile()) throw new Error('引用图片必须是普通文件')
            if (info.size > MAX_CHAT_ATTACHMENT_BYTES - total) throw new Error('输入图片合计不能超过 50 MiB')
            const buffer = Buffer.alloc(info.size + 1)
            let length = 0
            while (length < buffer.length) {
              const result = await file.read(buffer, length, buffer.length - length, null)
              if (!result.bytesRead) break
              length += result.bytesRead
              assertActive()
            }
            if (length > info.size) throw new Error('图片文件在读取期间发生变化，请重试')
            bytes = buffer.subarray(0, length)
          } finally {
            await file.close()
          }
        } else if (source.image) {
          if (source.image.data.length > Math.ceil((MAX_CHAT_ATTACHMENT_BYTES - total) / 3) * 4)
            throw new Error('输入图片合计不能超过 50 MiB')
          bytes = base64Bytes(source.image.data)
        } else throw new Error('图片引用缺少文件或图片数据')
        total += bytes.length
        if (total > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('输入图片合计不能超过 50 MiB')
        images.push({ bytes, mime: imageMime(bytes) })
      }
      const operation = images.length ? 'edit' : 'generate'
      const background =
        input.transparent_background == null
          ? images.length
            ? 'auto'
            : 'opaque'
          : input.transparent_background
            ? 'transparent'
            : 'opaque'
      const parameters = {
        model: model.model,
        prompt: input.prompt,
        n: 1,
        size: model.size,
        quality: model.quality,
        output_format: 'png',
        background,
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${model.apiKey}` }
      let body: string | FormData
      if (images.length) {
        const form = new FormData()
        for (const [name, value] of Object.entries(parameters)) form.append(name, String(value))
        images.forEach(({ bytes, mime }, index) => {
          const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
          form.append('image[]', new Blob([new Uint8Array(bytes)], { type: mime }), `input-${index}.${extension}`)
        })
        body = form
      } else {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(parameters)
      }
      assertActive()
      const response = await fetch(`${model.baseUrl}/images/${images.length ? 'edits' : 'generations'}`, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
      })
      if (!response.ok) {
        await response.body?.cancel()
        const reason =
          response.status === 401 || response.status === 403
            ? 'API Key 无效或无模型权限'
            : response.status === 429
              ? '图片服务限流或额度不足'
              : response.status === 404
                ? '图片模型或接口不存在，请检查模型 ID 和生图／编辑支持'
                : response.status === 400 || response.status === 422
                  ? '模型不支持当前参数或图片编辑，请检查模型能力'
                  : '图片服务请求失败'
        throw new Error(`${reason}（HTTP ${response.status}）`)
      }
      const raw = await readResponse(response, Math.ceil(maxImagePreviewBytes / 3) * 4 + 65536)
      let result: { data?: Array<{ b64_json?: string; url?: string }> }
      try {
        result = JSON.parse(raw.toString('utf8'))
      } catch {
        throw new Error('图片服务未返回有效 JSON')
      }
      const item = result?.data?.[0]
      let bytes: Buffer
      if (typeof item?.b64_json === 'string') bytes = base64Bytes(item.b64_json)
      else if (typeof item?.url === 'string')
        bytes = await downloadImage(item.url, new URL(model.baseUrl).origin, signal)
      else throw new Error('图片服务没有返回图片')
      if (bytes.length > maxImagePreviewBytes) throw new Error('生成图片超过 8 MiB')
      if (imageMime(bytes) !== 'image/png') throw new Error('图片服务未按要求返回 PNG 图片')
      assertActive()
      const id = randomUUID()
      const saved = await this.save(`${id}.png`, bytes, signal, execution.destinationDirectory)
      return {
        artifact: {
          id,
          path: saved.path,
          mimeType: 'image/png',
          operation,
          model: model.model,
          sources: sources.map(({ image: _image, ...source }) => source),
        },
        image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
      }
    } catch (cause) {
      if (execution.signal.aborted || controller.signal.aborted) throw new Error('图片生成已取消')
      if (timeout.aborted) throw new Error('图片生成超过五分钟，已停止等待；远端任务可能仍在执行')
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new Error('引用图片不存在，请重新提供图片')
      if (code === 'EACCES' || code === 'EPERM') throw new Error('没有读取引用图片的权限')
      const message = cause instanceof Error ? cause.message : '图片生成失败'
      if (cause instanceof TypeError) throw new Error('无法访问图片服务，请检查地址、网络与服务响应')
      throw new Error(message.replaceAll(model.apiKey, '[凭据已隐藏]'))
    } finally {
      this.pending.delete(controller)
    }
  }
}
