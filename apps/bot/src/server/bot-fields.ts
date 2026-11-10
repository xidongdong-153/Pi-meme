import type { AppState, Bot, Capability } from '../shared/types.js'
import { BotError, ids, requireItem, text } from './errors.js'
import { modelResource } from './model-settings.js'

/** Shared validation for direct configuration and confirmed conversation proposals. */
export function botFields(input: Record<string, unknown>, state: AppState, current?: Bot): Bot {
  const value = { ...current, ...input }
  const capabilities = ids(value.capabilities ?? [], '能力') as Capability[]
  if (capabilities.some((item) => !['collaborate', 'hosts', 'images', 'web', 'schedules'].includes(item)))
    throw new BotError(400, 'invalid-input', '能力名称无效')
  const collaboratorIds = ids(value.collaboratorIds ?? [], '协作角色')
  const hostIds = ids(value.hostIds ?? [], 'Host')
  for (const id of collaboratorIds) requireItem(state.bots[id], '协作角色')
  for (const id of hostIds) requireItem(state.hosts[id], 'Host')
  const grants = value.hostGrants ?? []
  if (!Array.isArray(grants) || grants.length > 500)
    throw new BotError(400, 'invalid-input', 'Host 项目授权须为最多 500 项的列表')
  const hostGrants: NonNullable<Bot['hostGrants']> = []
  for (const grant of grants) {
    if (
      !grant ||
      typeof grant !== 'object' ||
      Array.isArray(grant) ||
      Object.keys(grant).some((key) => key !== 'hostId' && key !== 'projectId')
    )
      throw new BotError(400, 'invalid-input', 'Host 项目授权字段无效')
    const hostId = text(grant.hostId, 'Host', 128)
    const projectId = text(grant.projectId, '项目', 128)
    const host = requireItem(state.hosts[hostId], 'Host')
    if (!host.projectIds.includes(projectId)) throw new BotError(403, 'forbidden', '项目超出 Host 已登记的授权范围')
    if (!hostGrants.some((item) => item.hostId === hostId && item.projectId === projectId))
      hostGrants.push({ hostId, projectId })
  }
  if (new Set([...hostIds, ...hostGrants.map((grant) => grant.hostId)]).size > 32)
    throw new BotError(400, 'invalid-input', '每个 Bot 最多授权 32 个 Host')
  const modelId =
    value.modelId === undefined || value.modelId === null || value.modelId === ''
      ? null
      : text(value.modelId, '对话模型', 128)
  if (modelId && requireItem(state.models[modelId], '模型').kind !== 'text')
    throw new BotError(400, 'invalid-input', '请选择支持图片与工具调用的对话模型')
  const maximum = value.maxToolCalls ?? 12
  if (!Number.isInteger(maximum) || Number(maximum) < 1 || Number(maximum) > 32)
    throw new BotError(400, 'invalid-input', '工具调用预算须为1–32整数')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new BotError(400, 'invalid-input', '启用状态须为布尔值')
  const bot: Bot = {
    ...(current ?? modelResource()),
    name: text(value.name, '名称', 80),
    avatar: text(value.avatar ?? '🤖', '头像', 100, true),
    description: text(value.description, '简介', 1000, true),
    instructions: text(value.instructions, '角色指令', 32000, !!current),
    modelId,
    enabled: value.enabled !== false,
    capabilities,
    collaboratorIds,
    hostIds,
    hostGrants,
    maxToolCalls: Number(maximum),
  }
  delete bot.resolvedModelId
  return bot
}

export function botView(state: AppState, bot: Bot): Bot {
  return { ...bot, resolvedModelId: bot.modelId ?? state.modelSettings.defaultModelId ?? undefined }
}
