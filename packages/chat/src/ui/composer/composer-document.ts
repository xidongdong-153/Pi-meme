import { skillMarker } from '@pi-meme/contracts/skills'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ComposerInline, ComposerStep } from '@pi-meme/plugin-sdk/composer'
import type { ComposerDraftData } from './composer-state'

export function composerDocument(value: ComposerDraftData): ComposerInline[] {
  const document: ComposerInline[] = []
  let skill = 0
  let text = ''
  const flush = () => {
    if (text) document.push({ kind: 'text', text })
    text = ''
  }
  for (let offset = 0; offset <= value.draft.length; offset++) {
    for (const id of value.pluginMentions.filter((id) => (value.pluginAnchors[id] ?? 0) === offset)) {
      flush()
      document.push({ kind: 'agent-plugin', id, name: id })
    }
    if (offset === value.draft.length) break
    if (value.draft[offset] === skillMarker) {
      flush()
      const entry = value.selectedSkills[skill++]
      if (entry)
        document.push({
          kind: 'skill',
          id: entry.resourceId ?? '',
          revision: entry.resourceRevision ?? '',
          name: entry.name,
        })
    } else text += value.draft[offset]
  }
  flush()
  return document
}
export function documentLength(document: readonly ComposerInline[]) {
  return document.reduce((length, part) => length + (part.kind === 'text' ? part.text.length : 1), 0)
}
function documentSlice(document: readonly ComposerInline[], from: number, to: number) {
  const result: ComposerInline[] = []
  let offset = 0
  for (const part of document) {
    const end = offset + (part.kind === 'text' ? part.text.length : 1)
    if (end > from && offset < to)
      result.push(
        part.kind === 'text' ? { ...part, text: part.text.slice(Math.max(0, from - offset), to - offset) } : part,
      )
    offset = end
  }
  return result
}
export function parseComposerDocument(
  document: readonly ComposerInline[],
  catalog: readonly PiSlashCommand[],
  previous: ComposerDraftData,
) {
  let draft = ''
  const selectedSkills: PiSlashCommand[] = []
  const pluginMentions: string[] = []
  const pluginAnchors: Record<string, number> = {}
  for (const part of document) {
    if (part.kind === 'text') {
      if (typeof part.text !== 'string' || part.text.includes(skillMarker))
        throw new Error('正文不能包含伪造的技能标记')
      draft += part.text
    } else if (part.kind === 'skill') {
      const skill = catalog.find(
        (entry) => entry.source === 'skill' && entry.resourceId === part.id && entry.resourceRevision === part.revision,
      )
      if (!skill) throw new Error('技能引用已失效，请重新选择技能')
      selectedSkills.push(skill)
      draft += skillMarker
    } else if (part.kind === 'agent-plugin') {
      if (!previous.pluginMentions.includes(part.id) || pluginMentions.includes(part.id))
        throw new Error('请通过插件选择接口修改 Agent 插件')
      pluginMentions.push(part.id)
      pluginAnchors[part.id] = draft.length
    } else throw new Error('输入片段类型无效')
  }
  if (pluginMentions.length !== previous.pluginMentions.length) throw new Error('请通过插件选择接口移除 Agent 插件')
  return { draft, selectedSkills, pluginMentions, pluginAnchors }
}
export function applyComposerSteps(
  value: ComposerDraftData,
  steps: readonly ComposerStep[],
  catalog: readonly PiSlashCommand[],
) {
  let document = composerDocument(value)
  let attachments = value.attachments
  for (const step of steps) {
    if (step.kind === 'remove-attachment') {
      if (!attachments.some((attachment) => attachment.id === step.id)) throw new Error('附件不属于当前草稿')
      attachments = attachments.filter((attachment) => attachment.id !== step.id)
      continue
    }
    if (step.kind === 'reorder-attachments') {
      if (
        new Set(step.ids).size !== attachments.length ||
        step.ids.length !== attachments.length ||
        step.ids.some((id) => !attachments.some((attachment) => attachment.id === id))
      )
        throw new Error('附件重排必须包含当前全部附件且不能重复')
      attachments = step.ids.map((id) => attachments.find((attachment) => attachment.id === id)!)
      continue
    }
    const { from, to } = step
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > documentLength(document))
      throw new Error('编辑范围无效')
    const logicalText = document.map((part) => (part.kind === 'text' ? part.text : skillMarker)).join('')
    for (const offset of [from, to]) {
      const before = logicalText.charCodeAt(offset - 1)
      const after = logicalText.charCodeAt(offset)
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
        throw new Error('编辑范围不能切开 Unicode 字符')
    }
    document = [
      ...documentSlice(document, 0, from),
      ...step.content,
      ...documentSlice(document, to, documentLength(document)),
    ]
  }
  return { ...parseComposerDocument(document, catalog, value), attachments }
}
