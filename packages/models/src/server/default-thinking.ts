import { thinkingLevels, type ThinkingLevel } from '@pi-meme/contracts/pi'
import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { createDesktopSettingsManager } from '@pi-meme/pi-runtime/sdk/settings'

/** 读写 Desktop 自有 Pi 目录中 settings.json 的 defaultThinkingLevel。 */
async function settingsManager(agentDir: string) {
  return createDesktopSettingsManager(await loadPiSdk(), agentDir, agentDir)
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (thinkingLevels as readonly string[]).includes(value)
}

export async function readDefaultThinkingLevel(agentDir: string): Promise<ThinkingLevel | null> {
  const level = (await settingsManager(agentDir)).getGlobalSettings().defaultThinkingLevel
  return isThinkingLevel(level) ? level : null
}

export async function saveDefaultThinkingLevel(agentDir: string, level: ThinkingLevel): Promise<void> {
  if (!isThinkingLevel(level)) throw new Error('思考强度参数无效')
  const settings = await settingsManager(agentDir)
  settings.setDefaultThinkingLevel(level)
  await settings.flush()
  const errors = settings.drainErrors()
  if (errors.length) throw new Error(`无法保存默认思考强度：${errors[0].error.message}`)
}
