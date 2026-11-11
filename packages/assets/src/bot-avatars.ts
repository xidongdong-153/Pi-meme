/** Bot 头像的稳定配置 ID 与选择器名称。空字符串表示原始主题头像。 */
export const botAvatarLabels = {
  'bot:frontend': '前端',
  'bot:backend': '后端',
  'bot:devops': '运维',
  'bot:requirements': '需求',
  'bot:product': '产品',
  'bot:director': '导演',
  'bot:writer': '作家',
  'bot:doctor': '医生',
  'bot:teacher': '教师',
  'bot:test': '测试',
  'bot:screenwriter': '剧本编辑',
  'bot:storyboard': '分镜',
  'bot:designer': '设计师',
  'bot:architect': '架构师',
  'bot:analyst': '数据分析师',
  'bot:researcher': '研究员',
  'bot:security': '安全工程师',
  'bot:photographer': '摄影师',
  'bot:musician': '音乐人',
  'bot:support': '客服',
} as const

export type BotAvatarPreset = keyof typeof botAvatarLabels

export function isBotAvatarPreset(value: unknown): value is BotAvatarPreset {
  return typeof value === 'string' && Object.hasOwn(botAvatarLabels, value)
}
