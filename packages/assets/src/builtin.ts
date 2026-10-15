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
] as const

/** 系统插件页图标。键是插件 id，换图时覆盖 system-plugins 下的同名文件。 */
export const systemPluginIcons: Record<string, string> = {
  '@pi-meme/git': new URL('../files/system-plugins/git.png', import.meta.url).href,
  '@pi-meme/file-directory': new URL('../files/system-plugins/file-directory.png', import.meta.url).href,
  '@pi-meme/terminal': new URL('../files/system-plugins/terminal.png', import.meta.url).href,
}

/** 系统技能页图标。键是技能名，换图时覆盖 system-skills 下的同名文件。 */
export const systemSkillIcons: Record<string, string> = {
  'skill-creator': new URL('../files/system-skills/skill-creator.png', import.meta.url).href,
  'plugin-creator': new URL('../files/system-skills/plugin-creator.png', import.meta.url).href,
}
