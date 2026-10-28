import type { ModelConfigSnapshot, ModelsReadonlyApi } from '@pi-meme/contracts/model-config'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { createDesktopModelRuntime, projectModel } from '@pi-meme/pi-runtime/sdk/model-runtime'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import type { ModelConfigStore } from './config-store'

export class ModelService implements ModelsReadonlyApi {
  constructor(
    private readonly pi: PiRuntime,
    readonly models: ModelConfigStore,
  ) {}

  async list() {
    const runtime = await createDesktopModelRuntime(
      await loadPiSdk(),
      this.models.agentDir,
      this.models.credentialStorage,
    )
    return runtime.getAvailableSnapshot().map(projectModel)
  }

  changeModels(write: () => Promise<ModelConfigSnapshot>) {
    return this.pi.idle(async () => {
      if (this.pi.connection().status === 'connecting') throw new Error('Pi 正在连接，请等待完成后重试')
      const restore = await this.pi.captureRestoreState()
      const snapshot = await write()
      try {
        await this.pi.reconnectModels(restore)
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
    }, true)
  }
}
