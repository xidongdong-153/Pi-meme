import type { PiModel, PiSlashCommand } from '@pi-meme/contracts/pi'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import { loadPiSdk } from './sdk/load'
import { createDesktopModelRuntime } from './sdk/model-runtime'
import { createDesktopSettingsManager } from './sdk/settings'

export async function readLocalModels(agentDir: string, credentials: SecureCredentialStorage): Promise<PiModel[]> {
  const sdk = await loadPiSdk()
  const runtime = await createDesktopModelRuntime(sdk, agentDir, credentials)
  return runtime.getAvailableSnapshot().map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning }))
}

export async function readLocalPreferences(cwd: string, agentDir: string) {
  const sdk = await loadPiSdk()
  const settings = createDesktopSettingsManager(sdk, cwd, agentDir)
  return {
    provider: settings.getDefaultProvider(),
    modelId: settings.getDefaultModel(),
    thinkingLevel: settings.getDefaultThinkingLevel(),
  }
}

export async function readLocalSkills(cwd: string, agentDir: string): Promise<PiSlashCommand[]> {
  const { loadSkills } = await loadPiSdk()
  const settings = createDesktopSettingsManager(await loadPiSdk(), cwd, agentDir)
  const { skills } = loadSkills({
    cwd,
    agentDir,
    skillPaths: settings.getSkillPaths(),
    includeDefaults: true,
  })
  return skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: 'skill',
    sourceInfo: skill.sourceInfo,
  }))
}
