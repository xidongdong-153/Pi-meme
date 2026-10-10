/** 思考过程的调皮文案列表，随机呈现给用户 */
export const PLAYFUL_THINKING_LABELS = [
  '坏点子生成中...',
  '脑细胞疯狂自旋中...',
  '正在密谋绝妙方案...',
  '假装在深度思考...',
  '正在酝酿一个大胆的想法...',
  '偷喝了一口机油正在运转...',
  '正在向宇宙借点灵感...',
  '正在调戏大模型神经元...',
  '逻辑电路正在光速碰撞...',
  '正在搜肠刮肚憋大招...',
  '脑洞正在以超光速展开...',
  '正在翻阅赛博秘籍...',
] as const

const thinkingLabelCache = new Map<string, string>()

/** 根据 seedKey（如 item.id）稳定获取随机思考文案 */
export function getThinkingLabel(seedKey?: string): string {
  if (seedKey && thinkingLabelCache.has(seedKey)) {
    return thinkingLabelCache.get(seedKey)!
  }
  const index = Math.floor(Math.random() * PLAYFUL_THINKING_LABELS.length)
  const label = PLAYFUL_THINKING_LABELS[index] ?? PLAYFUL_THINKING_LABELS[0]!
  if (seedKey) {
    thinkingLabelCache.set(seedKey, label)
  }
  return label
}

/** 清理文案缓存（主要供测试使用） */
export function clearThinkingLabelCache(): void {
  thinkingLabelCache.clear()
}
