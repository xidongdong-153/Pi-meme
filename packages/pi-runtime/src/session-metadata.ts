import {
  resolveThinkingLevel,
  thinkingLevels,
  type PiModel,
  type PiSlashCommand,
  type ThinkingLevel,
} from '@pi-meme/contracts/pi'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'
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

export function readModelPreferences(settings: SettingsManager) {
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

export async function readLocalPreferences(cwd: string, agentDir: string) {
  const sdk = await loadPiSdk()
  return readModelPreferences(createDesktopSettingsManager(sdk, cwd, agentDir))
}

// Pi SDK 1.6.0 的 core/model-resolver.ts。SDK 未导出这张表，升级时同步顺序和模型 ID。
const providerDefaults = {
  'amazon-bedrock': 'us.anthropic.claude-opus-5-5',
  'ant-ling': 'Ring-2.6-1T',
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6.2-sol',
  azure: 'gpt-6.2-sol',
  'openai-codex': 'gpt-6.2-sol',
  radius: 'balanced',
  nvidia: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  deepseek: 'deepseek-v4-pro',
  google: 'gemini-4-argon',
  'google-vertex': 'gemini-4-argon',
  'github-copilot': 'gpt-6.1-sol',
  openrouter: 'moonshotai/kimi-k2.7-code',
  'vercel-ai-gateway': 'zai/glm-5.3',
  xai: 'grok-4.7',
  groq: 'openai/gpt-oss-120b',
  cerebras: 'gpt-oss-120b',
  zai: 'glm-5.3',
  'zai-coding-cn': 'glm-5.3',
  mistral: 'devstral-medium-latest',
  minimax: 'MiniMax-M3',
  'minimax-cn': 'MiniMax-M3',
  moonshotai: 'kimi-k2.7-code',
  'moonshotai-cn': 'kimi-k2.7-code',
  huggingface: 'moonshotai/Kimi-K2.7-Code',
  fireworks: 'accounts/fireworks/models/kimi-k3',
  together: 'moonshotai/Kimi-K3',
  baseten: 'zai-org/GLM-5.3',
  opencode: 'kimi-k2.7-code',
  'opencode-go': 'kimi-k3.1-pro',
  'kimi-coding': 'kimi-for-coding',
  meta: 'muse-spark-1.3',
  'cloudflare-workers-ai': '@cf/moonshotai/kimi-k2.7-code',
  'cloudflare-ai-gateway': 'workers-ai/@cf/moonshotai/kimi-k2.7-code',
  'qwen-token-plan': 'qwen3.8-max',
  'qwen-token-plan-cn': 'qwen3.8-max',
  'qwen-token-plan-individual': 'qwen3.8-max',
  'qwen-token-plan-individual-cn': 'qwen3.8-max',
  xiaomi: 'mimo-v2.6-pro',
  'xiaomi-token-plan-cn': 'mimo-v2.6-pro',
  'xiaomi-token-plan-ams': 'mimo-v2.6-pro',
  'xiaomi-token-plan-sgp': 'mimo-v2.6-pro',
}

export function modelPreferenceThinkingLevel(model: PiModel, preferences: ReturnType<typeof readModelPreferences>) {
  return resolveThinkingLevel(
    model,
    preferences.modelThinkingLevels[`${model.provider}/${model.id}`] ?? preferences.thinkingLevel ?? 'medium',
  )
}

export function defaultModelConfiguration(
  models: readonly PiModel[],
  preferences: ReturnType<typeof readModelPreferences>,
) {
  const find = (provider: string | undefined, id: string | undefined) =>
    models.find((entry) => entry.provider === provider && entry.id === id)
  let model = find(preferences.provider, preferences.modelId)
  if (!model) {
    for (const [provider, id] of Object.entries(providerDefaults)) {
      model = find(provider, id)
      if (model) break
    }
  }
  model ??= models[0]
  if (!model) return undefined
  return {
    model,
    thinkingLevel: modelPreferenceThinkingLevel(model, preferences),
  }
}

export function readLocalSkills(snapshot: ResourceSnapshot): PiSlashCommand[] {
  return snapshot.skills.filter((item) => item.enabled && !item.shadowedBy).map(toResourceSkillCommand)
}
