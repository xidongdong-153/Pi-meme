import { randomUUID } from 'node:crypto'
import { isBotAvatarPreset } from '@pi-meme/assets/bot-avatars'
import type { AppState, Bot } from '../shared/types.js'
import { BotError, requireItem, text } from './errors.js'
import { modelResource } from './model-settings.js'

/** The Web editor and conversation tools use the same configuration rules. */
export function botFields(input: Record<string, unknown>, state: AppState, current?: Bot): Bot {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'name',
          'avatar',
          'description',
          'instructions',
          'modelId',
          'enabled',
          'maxToolCalls',
          'revision',
          'runningTasks',
        ].includes(key),
    )
  )
    throw new BotError(400, 'invalid-input', 'Bot 配置字段无效')
  const value = { ...current, ...input }
  const modelId =
    value.modelId === undefined || value.modelId === null || value.modelId === ''
      ? null
      : text(value.modelId, '对话模型', 128)
  if (modelId && requireItem(state.models[modelId], '模型').kind !== 'text')
    throw new BotError(400, 'invalid-input', '请选择支持工具调用的对话模型')
  const maximum = value.maxToolCalls ?? 32
  if (!Number.isInteger(maximum) || Number(maximum) < 1 || Number(maximum) > 128)
    throw new BotError(400, 'invalid-input', '工具调用预算须为1–128整数')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new BotError(400, 'invalid-input', '启用状态须为布尔值')
  const avatar = text(value.avatar, '头像', 100, true)
  if (avatar.startsWith('bot:') && !isBotAvatarPreset(avatar) && avatar !== current?.avatar)
    throw new BotError(400, 'invalid-input', '请选择有效的 Bot 头像')
  const bot: Bot = {
    ...(current ?? modelResource()),
    conversationId: current?.conversationId ?? randomUUID(),
    name: text(value.name, '名称', 80),
    avatar,
    description: text(value.description, '简介', 1000, true),
    instructions: text(value.instructions, '角色指令', 32000, !!current),
    modelId,
    enabled: value.enabled !== false,
    maxToolCalls: Number(maximum),
  }
  delete bot.resolvedModelId
  return bot
}

export function botView(state: AppState, bot: Bot): Bot {
  return { ...bot, resolvedModelId: bot.modelId ?? state.modelSettings.defaultModelId ?? undefined }
}
