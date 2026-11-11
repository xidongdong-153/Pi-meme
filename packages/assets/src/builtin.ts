import type { BotAvatarPreset } from './bot-avatars'

export const defaultUserAvatar = new URL('../files/profile/default-avatar.png', import.meta.url).href

/** 子代理头像。下标是 data-variant，换图时覆盖同名文件，不要改顺序。 */
export const agentAvatars = [
  new URL('../files/agents/general.png', import.meta.url).href,
  new URL('../files/agents/research.png', import.meta.url).href,
  new URL('../files/agents/plan.png', import.meta.url).href,
  new URL('../files/agents/code.png', import.meta.url).href,
  new URL('../files/agents/review.png', import.meta.url).href,
  new URL('../files/agents/test.png', import.meta.url).href,
  new URL('../files/agents/design.png', import.meta.url).href,
  new URL('../files/agents/docs.png', import.meta.url).href,
  new URL('../files/agents/frontend.png', import.meta.url).href,
  new URL('../files/agents/backend.png', import.meta.url).href,
  new URL('../files/agents/database.png', import.meta.url).href,
  new URL('../files/agents/devops.png', import.meta.url).href,
  new URL('../files/agents/security.png', import.meta.url).href,
  new URL('../files/agents/debug.png', import.meta.url).href,
  new URL('../files/agents/performance.png', import.meta.url).href,
  new URL('../files/agents/refactor.png', import.meta.url).href,
  new URL('../files/agents/browser.png', import.meta.url).href,
  new URL('../files/agents/data.png', import.meta.url).href,
  new URL('../files/agents/product.png', import.meta.url).href,
  new URL('../files/agents/localization.png', import.meta.url).href,
] as const

/** Bot 职业头像。保存稳定 ID，资源路径由构建时解析。 */
export const botAvatars: Record<BotAvatarPreset, string> = {
  'bot:frontend': new URL('../files/bots/frontend.png', import.meta.url).href,
  'bot:backend': new URL('../files/bots/backend.png', import.meta.url).href,
  'bot:devops': new URL('../files/bots/devops.png', import.meta.url).href,
  'bot:requirements': new URL('../files/bots/requirements.png', import.meta.url).href,
  'bot:product': new URL('../files/bots/product.png', import.meta.url).href,
  'bot:director': new URL('../files/bots/director.png', import.meta.url).href,
  'bot:writer': new URL('../files/bots/writer.png', import.meta.url).href,
  'bot:doctor': new URL('../files/bots/doctor.png', import.meta.url).href,
  'bot:teacher': new URL('../files/bots/teacher.png', import.meta.url).href,
  'bot:test': new URL('../files/bots/test.png', import.meta.url).href,
  'bot:screenwriter': new URL('../files/bots/screenwriter.png', import.meta.url).href,
  'bot:storyboard': new URL('../files/bots/storyboard.png', import.meta.url).href,
  'bot:designer': new URL('../files/bots/designer.png', import.meta.url).href,
  'bot:architect': new URL('../files/bots/architect.png', import.meta.url).href,
  'bot:analyst': new URL('../files/bots/analyst.png', import.meta.url).href,
  'bot:researcher': new URL('../files/bots/researcher.png', import.meta.url).href,
  'bot:security': new URL('../files/bots/security.png', import.meta.url).href,
  'bot:photographer': new URL('../files/bots/photographer.png', import.meta.url).href,
  'bot:musician': new URL('../files/bots/musician.png', import.meta.url).href,
  'bot:support': new URL('../files/bots/support.png', import.meta.url).href,
}

/** 系统插件页图标。键是插件 id，换图时覆盖 system-plugins 下的同名文件。 */
export const systemPluginIcons: Record<string, string> = {
  '@pi-meme/visualize': new URL('../files/system-plugins/visualize.png', import.meta.url).href,
  '@pi-meme/git': new URL('../files/system-plugins/git.png', import.meta.url).href,
  '@pi-meme/file-directory': new URL('../files/system-plugins/file-directory.png', import.meta.url).href,
  '@pi-meme/terminal': new URL('../files/system-plugins/terminal.png', import.meta.url).href,
}

/** 系统技能页图标。键是技能名，换图时覆盖 system-skills 下的同名文件。 */
export const systemSkillIcons: Record<string, string> = {
  'skill-creator': new URL('../files/system-skills/skill-creator.png', import.meta.url).href,
  'plugin-creator': new URL('../files/system-skills/plugin-creator.png', import.meta.url).href,
}

/** 斜杠菜单的内置命令图标。 */
export const builtinCommandIcons: Record<string, string> = {
  plan: new URL('../files/commands/plan.png', import.meta.url).href,
  goal: new URL('../files/commands/goal.png', import.meta.url).href,
  compact: new URL('../files/commands/compact.png', import.meta.url).href,
  name: new URL('../files/commands/name.png', import.meta.url).href,
}
