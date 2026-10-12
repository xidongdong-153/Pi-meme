import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ResourceItem } from '@pi-meme/contracts/resources'

export function toResourceSkillCommand(item: ResourceItem): PiSlashCommand {
  return {
    name: `skill:${item.name}`,
    resourceId: item.id,
    resourceRevision: item.revision,
    invocation: item.invocation,
    displayName: item.displayName,
    shortDescription: item.shortDescription,
    description: item.description,
    builtin: item.scope === 'builtin',
    source: 'skill',
    sourceInfo: {
      path: item.path,
      baseDir: item.baseDir,
      scope: item.scope === 'project' ? 'project' : 'user',
      source: item.scope,
      origin: 'top-level',
    },
  }
}
