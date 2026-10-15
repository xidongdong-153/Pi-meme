import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import type { PiModel } from '@pi-meme/contracts/pi'
import type { ModelConfigSnapshot } from '@pi-meme/contracts/model-config'
import { text } from '@pi-meme/contracts/ipc'
import type { ModelConfigStore } from './config-store'
import { createBuiltinAuth } from './builtin-auth'
import { discoverModels } from './discovery'
import { readDefaultModel, saveDefaultModel } from './default-model'
import { isThinkingLevel, readDefaultThinkingLevel, saveDefaultThinkingLevel } from './default-thinking'

export type ModelHandlerContext = {
  pi: PiRuntime
  models: ModelConfigStore
  agentDir: string
}

export function createModelHandlers({ pi, models, agentDir }: ModelHandlerContext) {
  const reconnect = async () => {
    try {
      await pi.idle(async () => {
        if (pi.connection().status === 'connecting') throw new Error('Pi 正在连接，请等待完成后重试')
        await pi.reconnectModels(await pi.captureRestoreState())
      }, true)
    } catch (cause) {
      return `凭据已更新，但 Pi 重连失败：${cause instanceof Error ? cause.message : String(cause)}。请在会话空闲后点击重新连接。`
    }
  }
  const builtin = createBuiltinAuth({
    agentDir,
    modelsPath: models.filePath,
    credentials: models.credentialStorage,
    reconnect,
  })
  const changeModels = (write: () => Promise<ModelConfigSnapshot>) =>
    pi.idle(async () => {
      if (pi.connection().status === 'connecting') throw new Error('Pi 正在连接，请等待完成后重试')
      const restore = await pi.captureRestoreState()
      const snapshot = await write()
      try {
        await pi.reconnectModels(restore)
        return { snapshot }
      } catch (cause) {
        return { snapshot, reconnectError: `模型配置已保存，但 Pi 重连失败：${String(cause)}。请点击重新连接。` }
      }
    }, true)
  return {
    'pi:set-model': (sessionKey: unknown, value: unknown) => {
      text(sessionKey)
      const model = value as PiModel | null
      if (!model) throw new Error('模型参数无效')
      text(model.provider)
      text(model.id)
      return pi.setModel(sessionKey, { provider: model.provider, id: model.id })
    },
    'pi:set-thinking-level': (sessionKey: unknown, value: unknown) => {
      text(sessionKey)
      if (!isThinkingLevel(value)) throw new Error('思考强度参数无效')
      return pi.setThinkingLevel(sessionKey, value)
    },
    'pi:thinking-levels': () => pi.getAvailableThinkingLevels(),
    'pi:session-stats': () => pi.getSessionStats(),
    'models:default': () => readDefaultModel(agentDir),
    'models:set-default': (value: unknown) => {
      const model = value as PiModel | null
      if (!model || typeof model !== 'object') throw new Error('默认模型参数无效')
      text(model.provider)
      text(model.id)
      return saveDefaultModel(agentDir, model.provider.trim(), model.id.trim())
    },
    'models:default-thinking': () => readDefaultThinkingLevel(agentDir),
    'models:set-default-thinking': (value: unknown) => {
      if (!isThinkingLevel(value)) throw new Error('思考强度参数无效')
      return saveDefaultThinkingLevel(agentDir, value)
    },
    'models:get': () => models.snapshot(),
    'models:save': (input: unknown) => changeModels(() => models.save(input)),
    'models:delete': (id: unknown, revision: unknown) => changeModels(() => models.delete(id, revision)),
    'models:discover': (input: unknown) => discoverModels(input, models),
    'models:reconnect': () => pi.idle(() => pi.reconnectModels(), true),
    'models:builtins': () => builtin.providers(),
    'models:builtin-login': (input: unknown) => builtin.start(input),
    'models:builtin-login-state': () => builtin.state(),
    'models:builtin-login-respond': (input: unknown) => builtin.respond(input),
    'models:builtin-login-cancel': () => builtin.cancel(),
    'models:builtin-logout': (id: unknown) => builtin.logout(id),
  }
}
