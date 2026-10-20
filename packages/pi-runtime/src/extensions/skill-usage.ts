import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ResourceItem, ResourceSnapshot } from '@pi-meme/contracts/resources'
import { skillMessageParts, type BranchSkillUsage, type SkillUsage } from '@pi-meme/contracts/skills'

export const skillUsageEntry = 'pi-meme.skill-use'
export const resourceSnapshotEntry = 'pi-meme.resource-snapshot'

export function branchSkillUsages(
  entries: readonly SessionEntry[],
  inheritedEntryIds: readonly string[] = [],
): BranchSkillUsage[] {
  const inherited = new Set(inheritedEntryIds)
  const usages = new Map<string, BranchSkillUsage>()
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== skillUsageEntry) continue
    const data = entry.data as Partial<SkillUsage> | undefined
    if (
      !data?.id ||
      !data.revision ||
      !data.name ||
      !data.path ||
      !['explicit', 'implicit-read'].includes(data.source ?? '')
    )
      continue
    const inheritedUsage = inherited.has(entry.id)
    const key = JSON.stringify([data.id, data.revision, inheritedUsage, data.source])
    usages.set(key, { ...(data as SkillUsage), inherited: inheritedUsage })
  }
  return [...usages.values()]
}

function canonical(value: string, cwd: string) {
  const resolved = path.resolve(cwd, value)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function usage(item: ResourceItem, source: SkillUsage['source']): SkillUsage {
  return { id: item.id, revision: item.revision, name: `skill:${item.name}`, path: item.path, source }
}

export function createSkillUsageExtension(snapshot: ResourceSnapshot): InlineExtension {
  const skills = snapshot.skills.filter((item) => item.enabled && !item.shadowedBy)
  const byPath = new Map(skills.map((item) => [canonical(item.path, snapshot.cwd), item]))
  return {
    name: 'pi-meme-skill-usage',
    factory: (pi) => {
      pi.on('session_start', (_event, ctx) => {
        const previous = ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === 'custom' && entry.customType === resourceSnapshotEntry)
        if (previous?.type !== 'custom' || (previous.data as { id?: string } | undefined)?.id !== snapshot.id)
          pi.appendEntry(resourceSnapshotEntry, {
            id: snapshot.id,
            generation: snapshot.generation,
            skills: skills.map(({ id, revision }) => ({ id, revision })),
          })
      })
      pi.on('message_end', (event, ctx) => {
        if (event.message.role !== 'user') return
        const text =
          typeof event.message.content === 'string'
            ? event.message.content
            : event.message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
        const seen = new Set<string>()
        for (const part of skillMessageParts(text)) {
          if (part.type !== 'skill') continue
          const item = byPath.get(canonical(part.path, ctx.cwd))
          if (!item || seen.has(item.id)) continue
          seen.add(item.id)
          pi.appendEntry(skillUsageEntry, { ...usage(item, 'explicit'), messageTimestamp: event.message.timestamp })
        }
      })
      pi.on('tool_result', (event, ctx) => {
        if (event.toolName !== 'read' || event.isError || typeof event.input.path !== 'string') return
        const item = byPath.get(canonical(event.input.path, ctx.cwd))
        if (!item) return
        pi.appendEntry(skillUsageEntry, {
          ...usage(item, 'implicit-read'),
          toolCallId: event.toolCallId,
          partial: event.input.offset !== undefined || event.input.limit !== undefined,
        })
      })
      pi.on('before_agent_start', (event, ctx) => {
        const used = new Map<string, ResourceItem>()
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== 'custom' || entry.customType !== skillUsageEntry) continue
          const data = entry.data as Partial<SkillUsage> | undefined
          const item = skills.find((item) => item.id === data?.id && item.revision === data.revision)
          if (item) used.set(item.id, item)
        }
        if (used.size)
          event.systemPromptOptions.sections.skill_usage = `The following skills have been used on this branch. Re-read relevant skill files when their bodies are no longer in context and the current task needs them. Skills do not change tool permissions.\n${[
            ...used.values(),
          ]
            .map((item) => `${item.name}: ${item.path}`)
            .join('\n')}`
      })
    },
  }
}
