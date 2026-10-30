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
