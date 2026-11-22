import type { Api, Model } from '@earendil-works/pi-ai'
import type { ContextServiceTier, ReportedServiceTier } from '@pi-meme/contracts/context-window'
import { isConfigurableFastModeApi, isOfficialFastModel } from '@pi-meme/contracts/model-config'
import type { PiModel, ServiceTier } from '@pi-meme/contracts/pi'

const codexFastDefaults = new Set(['gpt-6-sol', 'gpt-6-luna'])

export function modelSpeed(model: Model<Api>): Pick<PiModel, 'supportsFastMode' | 'defaultServiceTier'> {
  const codex = model.api === 'openai-codex-responses'
  if (!codex && !isConfigurableFastModeApi(model.api)) return {}
  const officialFast = isOfficialFastModel(model.api, model.baseUrl, model.id)
  const compat = model.compat as { supportsFastMode?: boolean; defaultServiceTier?: string } | undefined
  const catalog = model as Model<Api> & {
    service_tiers?: { id: string }[]
    additional_speed_tiers?: string[]
    default_service_tier?: string | null
  }
  // An explicitly empty catalog has already been filtered by the provider.
  const advertised =
    catalog.service_tiers || catalog.additional_speed_tiers
      ? catalog.service_tiers?.some((item) => item.id === 'priority') === true ||
        catalog.additional_speed_tiers?.includes('fast') === true
      : undefined
  if (compat?.supportsFastMode === false || !(advertised ?? compat?.supportsFastMode ?? officialFast)) return {}
  const configured = codex
    ? (compat?.defaultServiceTier ??
      ('default_service_tier' in catalog
        ? catalog.default_service_tier
        : officialFast && codexFastDefaults.has(model.id)
          ? 'priority'
          : undefined))
    : model.samplingParams?.service_tier
  return {
    supportsFastMode: true,
    defaultServiceTier:
      configured === 'priority' || configured === 'fast' ? 'fast' : configured === 'default' ? 'standard' : undefined,
  }
}

export type TurnServiceTier = { provider: string; id: string; tier: ServiceTier }

function reportedTier(value: unknown): ReportedServiceTier | undefined {
  switch (value) {
    case 'auto':
    case 'default':
    case 'priority':
    case 'fast':
    case 'flex':
    case 'scale':
    case 'ultrafast':
      return value
    default:
      return undefined
  }
}

export function sentServiceTier(body: unknown, selected: ServiceTier): ContextServiceTier {
  const field = body && typeof body === 'object' && 'service_tier' in body ? body.service_tier : undefined
  return { selected, sent: field === undefined ? 'omitted' : (reportedTier(field) ?? 'other') }
}

export function responseServiceTier(event: unknown): ReportedServiceTier | undefined {
  if (!event || typeof event !== 'object') return
  if ('object' in event && event.object === 'chat.completion.chunk' && 'service_tier' in event)
    return reportedTier(event.service_tier)
  if (
    !('type' in event) ||
    (event.type !== 'response.completed' && event.type !== 'response.done') ||
    !('response' in event)
  )
    return
  const response = event.response
  if (response && typeof response === 'object' && 'service_tier' in response) return reportedTier(response.service_tier)
}

/** Compose after SDK/extension transforms and before HTTP, SSE or WebSocket serialization. */
export function applyServiceTier(payload: unknown, model: Model<Api>, turn: TurnServiceTier | undefined): unknown {
  if (!turn || turn.provider !== model.provider || turn.id !== model.id) return payload
  const speed = modelSpeed(model)
  if (!speed.supportsFastMode) {
    if (turn.tier === 'fast') throw new Error('此模型当前不支持 Fast，请切换速度后重新发送')
    return payload
  }
  const codex = model.api === 'openai-codex-responses'
  if (turn.tier === 'inherit' && !codex) return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('无法对当前请求应用速度选择')
  const body = payload as Record<string, unknown>
  const tier = turn.tier === 'inherit' ? speed.defaultServiceTier : turn.tier
  if (codex && tier !== 'fast') {
    if (!Object.hasOwn(body, 'service_tier')) return payload
    const next = { ...body }
    delete next.service_tier
    return next
  }
  return { ...body, service_tier: tier === 'fast' ? 'priority' : 'default' }
}
