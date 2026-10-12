import { readFile } from 'node:fs/promises'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AgentConversationOrigin } from '@pi-meme/contracts/collaboration'
import type { PiMessage } from '@pi-meme/contracts/pi'
import { branchSkillUsages } from './extensions/skill-usage'
import { projectBranchEntries } from './session-tree-entries'
import { loadPiSdk } from './sdk/load'
import { projectMessageSources } from './sdk/ui-source'

export function projectAgentConversation(
  entries: readonly SessionEntry[],
  leafId: string | null,
  origin: AgentConversationOrigin,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const inherited = new Set(origin.inheritedEntryIds)
  const branch: SessionEntry[] = []
  const fullBranch: SessionEntry[] = []
  const seen = new Set<string>()
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    fullBranch.push(entry)
    if (!inherited.has(entry.id)) branch.push(entry)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  branch.reverse()
  const messages: PiMessage[] = branch.flatMap((current): PiMessage[] => {
    if (current.type === 'message') return current.message.role === 'system' ? [] : [current.message]
    if (current.type !== 'custom_message') return []
    return [
      {
        role: 'custom',
        customType: current.customType,
        content: current.content,
        display: current.display,
        details: current.details,
        timestamp: new Date(current.timestamp).getTime(),
      },
    ]
  })
  const ownIds = new Set(branch.map((current) => current.id))
  return {
    messages: projectMessageSources(branch, messages),
    skillUsages: branchSkillUsages(fullBranch.reverse(), origin.inheritedEntryIds),
    sessionEntries: {
      entries: projectBranchEntries(branch).map((current) => ({
        ...current,
        parentId: current.parentId && ownIds.has(current.parentId) ? current.parentId : null,
      })),
      leafId: branch.at(-1)?.id ?? null,
    },
  }
}

export async function readAgentConversation(file: string, origin: AgentConversationOrigin) {
  const { parseSessionEntries, migrateSessionEntries } = await loadPiSdk()
  const entries = parseSessionEntries(await readFile(file, 'utf8'))
  migrateSessionEntries(entries)
  const history = entries.filter((entry): entry is SessionEntry => entry.type !== 'session')
  return projectAgentConversation(history, history.at(-1)?.id ?? null, origin)
}

/** 旧child只按原生父文件和共享条目ID恢复边界；不改JSONL。 */
export async function inferAgentConversationOrigin(
  file: string,
  parentAgentId: string,
): Promise<AgentConversationOrigin | undefined> {
  const { parseSessionEntries } = await loadPiSdk()
  const entries = parseSessionEntries(await readFile(file, 'utf8'))
  const header = entries.find((entry) => entry.type === 'session')
  if (!header?.parentSession) return undefined
  let parent
  try {
    parent = parseSessionEntries(await readFile(header.parentSession, 'utf8'))
  } catch {
    throw new Error('父会话文件无法读取，不能确认继承历史边界；暂时无法展示此 Agent 详情')
  }
  const parentIds = new Set(parent.filter((entry) => entry.type !== 'session').map((entry) => entry.id))
  const inheritedEntryIds: string[] = []
  for (const entry of entries) {
    if (entry.type === 'session') continue
    if (!parentIds.has(entry.id) && !(entry.type === 'label' && inheritedEntryIds.includes(entry.targetId))) break
    inheritedEntryIds.push(entry.id)
  }
  if (!inheritedEntryIds.length)
    throw new Error('父子会话没有可验证的共同条目，不能确认继承历史边界；暂时无法展示此 Agent 详情')
  return { parentAgentId, inheritedLeafId: inheritedEntryIds.at(-1) ?? null, inheritedEntryIds }
}
