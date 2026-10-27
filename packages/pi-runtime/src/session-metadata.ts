import {
  resolveThinkingLevel,
  thinkingLevels,
  type PiModel,
  type PiSlashCommand,
  type ThinkingLevel,
} from '@pi-meme/contracts/pi'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { loadPiSdk } from './sdk/load'
import { createDesktopModelRuntime, projectModel } from './sdk/model-runtime'
import { createDesktopSettingsManager } from './sdk/settings'
import { toResourceSkillCommand } from './skill-command'
import type { ResourceSnapshot } from '@pi-meme/contracts/resources'

export async function readLocalModels(agentDir: string, credentials: SecureCredentialStorage): Promise<PiModel[]> {
  const sdk = await loadPiSdk()
  const runtime = await createDesktopModelRuntime(sdk, agentDir, credentials)
  return runtime.getAvailableSnapshot().map(projectModel)
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && (thinkingLevels as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined
}

export async function readLocalPreferences(cwd: string, agentDir: string) {
  const sdk = await loadPiSdk()
  const settings = createDesktopSettingsManager(sdk, cwd, agentDir)
  const modelThinkingLevels: Partial<Record<string, ThinkingLevel>> = {}
  for (const [key, level] of Object.entries(settings.getAllModelThinkingLevels())) {
    const thinkingLevel = asThinkingLevel(level)
    if (thinkingLevel) modelThinkingLevels[key] = thinkingLevel
  }
  return {
    provider: settings.getDefaultProvider(),
    modelId: settings.getDefaultModel(),
    thinkingLevel: asThinkingLevel(settings.getDefaultThinkingLevel()),
    modelThinkingLevels,
  }
}

export function defaultModelConfiguration(
  models: PiModel[],
  preferences: Awaited<ReturnType<typeof readLocalPreferences>>,
) {
  const model =
    models.find((entry) => entry.provider === preferences.provider && entry.id === preferences.modelId) ?? models[0]
  if (!model) return undefined
  return {
    model,
    thinkingLevel: resolveThinkingLevel(
      model,
      preferences.modelThinkingLevels[`${model.provider}/${model.id}`] ?? preferences.thinkingLevel ?? 'medium',
    ),
  }
}

export function readLocalSkills(snapshot: ResourceSnapshot): PiSlashCommand[] {
  return snapshot.skills.filter((item) => item.enabled && !item.shadowedBy).map(toResourceSkillCommand)
}
