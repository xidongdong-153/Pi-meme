import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent'
import type { ResourceItem, ResourceSnapshot } from '@pi-meme/contracts/resources'

export function snapshotSkills(snapshot?: ResourceSnapshot): Skill[] {
  return (snapshot?.skills ?? [])
    .filter((item) => item.kind === 'skill' && item.enabled && !item.shadowedBy)
    .map((item) => ({
      name: item.name,
      description: item.description ?? '',
      filePath: item.path,
      baseDir: item.baseDir,
      disableModelInvocation: item.invocation === 'manual',
      sourceInfo: {
        path: item.path,
        baseDir: item.baseDir,
        scope: item.scope === 'project' ? ('project' as const) : ('user' as const),
        source: item.scope,
        origin: 'top-level' as const,
      },
    }))
}

export function approvedSnapshotExtensions(snapshot?: ResourceSnapshot): ResourceItem[] {
  return (snapshot?.extensions ?? []).filter((item) => item.kind === 'extension' && item.enabled && !item.shadowedBy)
}

/** 保留 Pi 公开加载器；扩展返回的动态资源路径不能扩大 Host 清单。 */
export function freezeResourceLoader(
  loader: ResourceLoader,
  report: (message: string) => void,
  snapshot?: ResourceSnapshot,
): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getSystemPromptSource: () => loader.getSystemPromptSource(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    reload: (options) => loader.reload(options),
    extendResources: (paths) => {
      const registered = new Set(snapshot?.skills.map((item) => item.path))
      const extra = (paths.skillPaths ?? []).filter((item) => !registered.has(item.path))
      if (extra.length)
        report(`扩展动态技能路径未加载，请通过扩展中心登记：${extra.map((item) => item.path).join('、')}`)
      if (paths.promptPaths?.length || paths.themePaths?.length)
        loader.extendResources({ promptPaths: paths.promptPaths, themePaths: paths.themePaths })
    },
  }
}
