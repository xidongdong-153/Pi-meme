import type { ModelConfigSnapshot, ModelsReadonlyApi } from '@pi-meme/contracts/model-config'
import type { PiModel } from '@pi-meme/contracts/pi'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { createDesktopModelRuntime, projectModel } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import type { ModelConfigStore } from './config-store'

export class ModelService implements ModelsReadonlyApi {
  private capturedModels?: PiModel[]
  private capturedAt?: string

  constructor(
    private readonly pi: PiRuntime,
    readonly models: ModelConfigStore,
  ) {}

  /** Called by Host startup and explicit configuration/reconnect lifecycles, never by a reader. */
  async refreshCatalog() {
    const runtime = await createDesktopModelRuntime(
      await loadPiSdk(),
      this.models.agentDir,
      this.models.credentialStorage,
    )
    this.capturedModels = runtime.getAvailableSnapshot().map(projectModel)
    this.capturedAt = new Date().toISOString()
    return this.catalogStatus()
  }

  catalogStatus() {
    return {
      loaded: this.capturedModels !== undefined,
      source: 'host-captured' as const,
      capturedAt: this.capturedAt,
      count: this.capturedModels?.length,
    }
  }

  async list() {
    if (this.capturedModels === undefined) throw new Error('模型目录尚未在 Host 启动阶段加载')
    const loaded = this.pi.peekModels()
    return structuredClone(loaded.length ? loaded : this.capturedModels)
  }

  changeModels(write: () => Promise<ModelConfigSnapshot>) {
    return this.pi.idle(async () => {
      if (this.pi.connection().status === 'connecting') throw new Error('Pi 正在连接，请等待完成后重试')
      const restore = await this.pi.captureRestoreState()
      const snapshot = await write()
      try {
        await this.pi.reconnectModels(restore)
        await this.refreshCatalog()
        return { snapshot }
      } catch {
        return { snapshot, reconnectError: '模型配置已保存，但 Pi 重连失败。请在会话空闲后点击重新连接。' }
      }
    }, true)
  }

  reconnect() {
    return this.pi.idle(async () => {
      if (this.pi.connection().status === 'connecting') throw new Error('Pi 正在连接，请等待完成后重试')
      await this.pi.reconnectModels(await this.pi.captureRestoreState())
      await this.refreshCatalog()
    }, true)
  }
}
