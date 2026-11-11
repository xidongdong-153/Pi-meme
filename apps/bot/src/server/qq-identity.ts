import type { AppState, QqTarget } from '../shared/types.js'
import { BotError } from './errors.js'

export function currentQqTarget(state: AppState): QqTarget {
  const config = state.qq
  if (!config.enabled || !config.appId || !config.boundUserId || !config.bindingId)
    throw new BotError(409, 'capability-unavailable', '请先启用 QQ 并绑定本人账号')
  return { appId: config.appId, userId: config.boundUserId, bindingId: config.bindingId }
}

export function isCurrentQqTarget(state: AppState, target: QqTarget | undefined): target is QqTarget {
  return Boolean(
    target &&
    state.qq.enabled &&
    state.qq.bindingId &&
    state.qq.appId === target.appId &&
    state.qq.boundUserId === target.userId &&
    state.qq.bindingId === target.bindingId,
  )
}
