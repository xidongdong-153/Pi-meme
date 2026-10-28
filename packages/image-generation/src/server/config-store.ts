import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  imageGenerationCredentialPrefix,
  imageQualities,
  imageSizes,
  type ImageGenerationConfig,
  type ImageModelConfig,
  type SaveImageModel,
} from '@pi-meme/contracts/image-generation'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'

type StoredModel = Omit<ImageModelConfig, 'hasApiKey'> & { credentialRef?: string }
type StoredConfig = { version: 1; models: StoredModel[]; defaultId?: string }

function validateModel(raw: unknown): Omit<ImageModelConfig, 'hasApiKey'> {
  const value = raw as ImageModelConfig
  if (!value || typeof value !== 'object') throw new Error('图片模型配置无效')
  for (const field of ['id', 'name', 'baseUrl', 'model'] as const)
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 2048)
      throw new Error(`图片模型 ${field} 必须是非空字符串，且不超过 2048 字符`)
  let url: URL
  try {
    url = new URL(value.baseUrl)
  } catch {
    throw new Error('Base URL 必须是完整的 HTTP(S) 地址')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Base URL 必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段')
  if (!imageSizes.includes(value.size) || !imageQualities.includes(value.quality)) throw new Error('图片尺寸或质量无效')
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    baseUrl: url.href.replace(/\/+$/, ''),
    model: value.model.trim(),
    size: value.size,
    quality: value.quality,
  }
}

export class ImageConfigStore {
  private writing = false
  constructor(
    readonly file: string,
    private readonly credentials: SecureCredentialStorage & { flush?: () => Promise<void> },
  ) {}

  private async read(): Promise<{ value: StoredConfig; revision: string }> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        return { value: { version: 1, models: [] }, revision: '0' }
      throw new Error('无法读取图片模型配置，请检查文件权限')
    }
    try {
      const value = JSON.parse(raw) as StoredConfig
      if (value.version !== 1 || !Array.isArray(value.models)) throw new Error('图片模型配置结构无效')
      const ids = new Set<string>()
      for (const model of value.models) {
        validateModel(model)
        if (ids.has(model.id)) throw new Error('图片模型配置结构无效')
        ids.add(model.id)
        if (
          model.credentialRef !== undefined &&
          (typeof model.credentialRef !== 'string' || !model.credentialRef.startsWith(imageGenerationCredentialPrefix))
        )
          throw new Error('图片模型配置结构无效')
      }
      if (value.defaultId !== undefined && !ids.has(value.defaultId)) throw new Error('图片模型配置结构无效')
      return { value, revision: createHash('sha256').update(raw).digest('hex') }
    } catch {
      throw new Error('图片模型配置损坏或版本不支持，原文件已保留')
    }
  }

  async snapshot(): Promise<ImageGenerationConfig> {
    try {
      const { value, revision } = await this.read()
      return {
        revision,
        defaultId: value.defaultId,
        models: value.models.map(({ credentialRef, ...model }) => ({
          ...model,
          hasApiKey: Boolean(credentialRef && this.credentials.get(credentialRef)),
        })),
      }
    } catch (cause) {
      return { revision: '', models: [], error: (cause as Error).message }
    }
  }

  async selected(id?: string) {
    const { value } = await this.read()
    const model = value.models.find((item) => item.id === (id ?? value.defaultId))
    const apiKey = model?.credentialRef ? this.credentials.get(model.credentialRef) : undefined
    if (!model || !apiKey) throw new Error('请先在“设置 → Agent → 图片生成”配置默认模型和 API Key')
    return { ...model, apiKey }
  }

  private async change(revision: string, update: (value: StoredConfig) => Promise<void>) {
    if (this.writing) throw new Error('图片配置正在保存，请稍后重试')
    this.writing = true
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const current = await this.read()
      if (current.revision !== revision) throw new Error('图片模型配置已变化，请刷新后重试')
      await update(current.value)
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(current.value, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.file)
      return await this.snapshot()
    } finally {
      this.writing = false
      await rm(temporary, { force: true })
    }
  }

  async save(input: SaveImageModel) {
    if (!input || typeof input.revision !== 'string') throw new Error('图片模型保存参数无效')
    const model = validateModel(input.model)
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== 'string' ||
        !input.apiKey.trim() ||
        input.apiKey.length > 8192 ||
        /[\r\n]/.test(input.apiKey))
    )
      throw new Error('API Key 无效')
    if (input.apiKey && input.clearApiKey) throw new Error('不能同时替换和清除 API Key')
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean')
      throw new Error('清除凭据标志必须是布尔值')
    let newKey: string | undefined
    let oldKey: string | undefined
    try {
      const result = await this.change(input.revision, async (value) => {
        const old = value.models.find((item) => item.id === model.id)
        if (!old && !input.apiKey) throw new Error('新增图片模型时必须填写 API Key')
        oldKey = old?.credentialRef
        if (old && new URL(old.baseUrl).origin !== new URL(model.baseUrl).origin && !input.apiKey && !input.clearApiKey)
          throw new Error('更换服务地址的 origin 时，请重新填写或清除 API Key')
        let credentialRef = input.clearApiKey ? undefined : oldKey
        if (input.apiKey) {
          newKey = `${imageGenerationCredentialPrefix}${randomUUID()}`
          this.credentials.set(newKey, input.apiKey.trim())
          await this.credentials.flush?.()
          credentialRef = newKey
        }
        const next = { ...model, credentialRef }
        if (old) value.models[value.models.indexOf(old)] = next
        else {
          if (!value.models.length && credentialRef) value.defaultId = model.id
          value.models.push(next)
        }
      })
      if (oldKey && (newKey || input.clearApiKey)) {
        this.credentials.delete(oldKey)
        await this.credentials.flush?.()
      }
      return result
    } catch (cause) {
      if (newKey) {
        // 配置写入失败时，旧配置仍使用旧凭据。
        const selected = await this.read().catch(() => undefined)
        if (!selected?.value.models.some((item) => item.credentialRef === newKey)) {
          try {
            this.credentials.delete(newKey)
            await this.credentials.flush?.()
          } catch {}
        }
      }
      throw cause
    }
  }

  async delete(id: string, revision: string) {
    let credentialRef: string | undefined
    const result = await this.change(revision, async (value) => {
      const model = value.models.find((item) => item.id === id)
      if (!model) throw new Error('图片模型配置不存在')
      credentialRef = model.credentialRef
      value.models = value.models.filter((item) => item.id !== id)
      if (value.defaultId === id) delete value.defaultId
    })
    if (credentialRef) {
      this.credentials.delete(credentialRef)
      await this.credentials.flush?.()
    }
    return result
  }

  setDefault(id: string, revision: string) {
    return this.change(revision, async (value) => {
      if (!value.models.some((model) => model.id === id)) throw new Error('图片模型配置不存在')
      value.defaultId = id
    })
  }
}
