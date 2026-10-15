import { skillMarker } from '@pi-meme/contracts/skills'

/** 在草稿末尾追加一个技能标记。有提示语时跟在标记后面，供设置页唤起系统技能。 */
export function appendSkillInvocation(draft: string, prompt?: string) {
  const gap = draft && !/\s$/u.test(draft) ? ' ' : ''
  return `${draft}${gap}${skillMarker}${prompt ? ` ${prompt}` : ' '}`
}
