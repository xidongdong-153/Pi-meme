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
import { savedEndpoint, type SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'

type StoredModel = Omit<ImageModelConfig, 'hasApiKey' | 'baseUrl'> & { baseUrl?: string; credentialRef?: string }
type ImageConnection = { baseUrl: string; apiKey?: string }
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

  private connection(model: StoredModel): ImageConnection {
    const value = model.credentialRef ? this.credentials.get(model.credentialRef) : undefined
    if (model.baseUrl !== undefined) return { baseUrl: model.baseUrl, apiKey: value }
    const connection = value ? (JSON.parse(value) as Partial<ImageConnection>) : undefined
    if (
      typeof connection?.baseUrl !== 'string' ||
      (connection.apiKey !== undefined && typeof connection.apiKey !== 'string')
    )
      throw new Error('图片模型连接配置不可用')
    return { baseUrl: connection.baseUrl, apiKey: connection.apiKey }
  }

  private storeConnection(model: StoredModel, connection: ImageConnection): StoredModel {
    const { baseUrl: _legacyUrl, ...metadata } = validateModel({ ...model, baseUrl: connection.baseUrl })
    const credentialRef = `${imageGenerationCredentialPrefix}${randomUUID()}`
    this.credentials.set(credentialRef, JSON.stringify(connection))
    return { ...metadata, credentialRef }
  }

  private async releaseCredentials(refs: string[]) {
    if (!refs.length) return
    const current = await this.read().catch(() => undefined)
    if (!current) return
    const used = new Set(current.value.models.map((model) => model.credentialRef))
    for (const ref of refs) if (!used.has(ref)) this.credentials.delete(ref)
    await this.credentials.flush?.()
  }

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
        validateModel({ ...model, baseUrl: this.connection(model).baseUrl })
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

  async migratePrivateConfig() {
    const current = await this.read().catch(() => undefined)
    if (!current?.value.models.some((model) => model.baseUrl !== undefined)) return
    const previous = new Set<string>()
    await this.change(current.revision, (value) => {
      value.models = value.models.map((model) => {
        if (model.baseUrl === undefined) return model
        if (model.credentialRef) previous.add(model.credentialRef)
        return this.storeConnection(model, this.connection(model))
      })
      for (const model of value.models) if (model.credentialRef) previous.delete(model.credentialRef)
    })
    await this.releaseCredentials([...previous])
  }

  async snapshot(): Promise<ImageGenerationConfig> {
    try {
      const { value, revision } = await this.read()
      return {
        revision,
        defaultId: value.defaultId,
        models: value.models.map((item) => ({
          ...validateModel({ ...item, baseUrl: savedEndpoint }),
          hasApiKey: Boolean(this.connection(item).apiKey),
        })),
      }
    } catch (cause) {
      return { revision: '', models: [], error: (cause as Error).message }
    }
  }

  async selected(id?: string) {
    const { value } = await this.read()
    const model = value.models.find((item) => item.id === (id ?? value.defaultId))
    const connection = model && this.connection(model)
    if (!model || !connection?.apiKey) throw new Error('请先在“设置 → Agent → 图片生成”配置默认模型和 API Key')
    return { ...model, baseUrl: connection.baseUrl, apiKey: connection.apiKey }
  }

  private async change(revision: string, update: (value: StoredConfig) => void) {
    if (this.writing) throw new Error('图片配置正在保存，请稍后重试')
    this.writing = true
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const current = await this.read()
      if (current.revision !== revision) throw new Error('图片模型配置已变化，请刷新后重试')
      update(current.value)
      await this.credentials.flush?.()
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(current.value, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if ((await this.read()).revision !== revision) throw new Error('图片模型配置已变化，请刷新后重试')
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
      const result = await this.change(input.revision, (value) => {
        const old = value.models.find((item) => item.id === model.id)
        const previous = old && this.connection(old)
        if (!old && !input.apiKey) throw new Error('新增图片模型时必须填写 API Key')
        if (model.baseUrl === savedEndpoint) {
          if (!previous) throw new Error('请填写图片模型服务地址')
          model.baseUrl = previous.baseUrl
        }
        oldKey = old?.credentialRef
        if (
          previous?.apiKey &&
          new URL(previous.baseUrl).origin !== new URL(model.baseUrl).origin &&
          !input.apiKey &&
          !input.clearApiKey
        )
          throw new Error('更换服务地址的 origin 时，请重新填写或清除 API Key')
        const apiKey = input.clearApiKey ? undefined : (input.apiKey?.trim() ?? previous?.apiKey)
        const next = this.storeConnection(model, { baseUrl: model.baseUrl, apiKey })
        newKey = next.credentialRef
        if (old) value.models[value.models.indexOf(old)] = next
        else {
          if (!value.models.length && apiKey) value.defaultId = model.id
          value.models.push(next)
        }
      })
      if (oldKey) await this.releaseCredentials([oldKey])
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
    const result = await this.change(revision, (value) => {
      const model = value.models.find((item) => item.id === id)
      if (!model) throw new Error('图片模型配置不存在')
      credentialRef = model.credentialRef
      value.models = value.models.filter((item) => item.id !== id)
      if (value.defaultId === id) delete value.defaultId
    })
    if (credentialRef) await this.releaseCredentials([credentialRef])
    return result
  }

  setDefault(id: string, revision: string) {
    return this.change(revision, (value) => {
      if (!value.models.some((model) => model.id === id)) throw new Error('图片模型配置不存在')
      value.defaultId = id
    })
  }
}
