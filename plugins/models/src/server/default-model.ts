import type { PiModel } from '@pi-meme/contracts/pi'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { createDesktopSettingsManager } from '@pi-meme/pi-runtime/sdk/settings'

/** 读写 Desktop 自有 Pi 目录中的 settings.json 默认模型。 */
async function settingsManager(agentDir: string) {
  return createDesktopSettingsManager(await loadPiSdk(), agentDir, agentDir)
}

export async function readDefaultModel(agentDir: string): Promise<PiModel | null> {
  const settings = (await settingsManager(agentDir)).getGlobalSettings()
  if (!settings.defaultProvider || !settings.defaultModel) return null
  return { provider: settings.defaultProvider, id: settings.defaultModel }
}

export async function saveDefaultModel(agentDir: string, provider: string, id: string): Promise<void> {
  const settings = await settingsManager(agentDir)
  settings.setDefaultModelAndProvider(provider, id)
  await settings.flush()
  const errors = settings.drainErrors()
  if (errors.length) throw new Error(`无法保存默认模型：${errors[0].error.message}`)
}
