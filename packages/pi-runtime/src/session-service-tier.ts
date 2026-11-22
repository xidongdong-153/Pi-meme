import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import {
  isServiceTier,
  modelServiceTier,
  updateModelServiceTier,
  type ModelServiceTiers,
  type PiModel,
  type ServiceTier,
} from '@pi-meme/contracts/pi'

export const serviceTierEntry = 'pi-meme-service-tier'
type TierEntry = Pick<PiModel, 'provider' | 'id'> & { tier: ServiceTier }

export function readServiceTierEntry(entry: SessionEntry): TierEntry | undefined {
  if (entry.type !== 'custom' || entry.customType !== serviceTierEntry) return
  const data = entry.data as Partial<TierEntry> | null
  if (data && typeof data.provider === 'string' && typeof data.id === 'string' && isServiceTier(data.tier))
    return { provider: data.provider, id: data.id, tier: data.tier }
}

export function branchServiceTiers(branch: readonly SessionEntry[]): ModelServiceTiers | undefined {
  let selections: ModelServiceTiers | undefined
  for (const entry of branch) {
    const data = readServiceTierEntry(entry)
    if (data) selections = updateModelServiceTier(data, data.tier, selections)
  }
  return selections
}

export function appendServiceTier(manager: SessionManager, model: PiModel, tier: ServiceTier) {
  const selections = branchServiceTiers(manager.getBranch())
  if (modelServiceTier(model, selections) === tier) return selections
  manager.appendCustomEntry(serviceTierEntry, { provider: model.provider, id: model.id, tier } satisfies TierEntry)
  return updateModelServiceTier(model, tier, selections)
}

export function restoreDraftServiceTiers(manager: SessionManager, selections: ModelServiceTiers | undefined) {
  if (
    !selections ||
    manager
      .getBranch()
      .some((entry) => entry.type === 'message' || (entry.type === 'custom' && entry.customType === serviceTierEntry))
  )
    return
  for (const [key, tier] of Object.entries(selections)) {
    let identity: unknown
    try {
      identity = JSON.parse(key)
    } catch {
      continue
    }
    if (
      !Array.isArray(identity) ||
      identity.length !== 2 ||
      !identity.every((part) => typeof part === 'string' && part.length) ||
      !isServiceTier(tier)
    )
      continue
    const [provider, id] = identity
    manager.appendCustomEntry(serviceTierEntry, { provider, id, tier } satisfies TierEntry)
  }
}
