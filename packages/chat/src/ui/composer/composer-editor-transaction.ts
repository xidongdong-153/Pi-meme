import type { ComposerInline } from '@pi-meme/plugin-sdk/composer'
import type { AgentPluginOption } from './composer'
import type { ComposerDraftData, ComposerDraftState } from './composer-state'
import { composerDocument } from './composer-document'
import { createEditorToken, editorPluginPositions } from './editor-plugin-tokens'
import { editorSelection, readEditorText, setEditorSelection } from './rich-draft'

type Selection = { anchor: number; focus: number }
function units(value: ComposerDraftData) {
  return composerDocument(value).flatMap((part) =>
    part.kind === 'text' ? Array.from(part.text, (text): ComposerInline => ({ kind: 'text', text })) : [part],
  )
}
function key(part: ComposerInline) {
  return JSON.stringify(part)
}
function length(parts: ComposerInline[]) {
  return parts.reduce((size, part) => size + (part.kind === 'text' ? part.text.length : 1), 0)
}
function nodes(parts: ComposerInline[], value: ComposerDraftData, plugins: AgentPluginOption[]) {
  const result: Node[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      const previous = result.at(-1)
      if (previous?.nodeType === Node.TEXT_NODE) previous.textContent += part.text
      else result.push(document.createTextNode(part.text))
    } else if (part.kind === 'agent-plugin') {
      const plugin = plugins.find((entry) => entry.id === part.id)
      result.push(createEditorToken('plugin', part.id, plugin?.name ?? part.name, plugin?.description, plugin?.iconUrl))
    } else {
      const skill = value.selectedSkills.find(
        (entry) => entry.resourceId === part.id && entry.resourceRevision === part.revision,
      )
      const token = createEditorToken(
        'skill',
        part.id || part.name,
        skill?.displayName ?? part.name.replace(/^skill:/, ''),
        skill?.sourceInfo.path,
      )
      token.dataset.skillRevision = part.revision
      result.push(token)
    }
  }
  return result
}
export function editorDraftNodes(value: ComposerDraftData, plugins: AgentPluginOption[]) {
  return nodes(composerDocument(value), value, plugins)
}
export function editorMatchesDraft(element: HTMLElement, value: ComposerDraftData) {
  if (readEditorText(element) !== value.draft) return false
  const skills = [...element.querySelectorAll<HTMLElement>('[data-skill-token]')]
  if (
    skills.length !== value.selectedSkills.length ||
    skills.some(
      (token, index) =>
        token.dataset.skillToken !== (value.selectedSkills[index].resourceId ?? value.selectedSkills[index].name) ||
        token.dataset.skillRevision !== (value.selectedSkills[index].resourceRevision ?? ''),
    )
  )
    return false
  const anchors = editorPluginPositions(element)
  return (
    anchors.size === value.pluginMentions.length &&
    value.pluginMentions.every((id) => anchors.get(id) === (value.pluginAnchors[id] ?? 0))
  )
}

/** 仅供已通过 CAS 的 SDK 事务调用；一次原生命令形成一个浏览器编辑事务。 */
export function applyEditorTransaction(
  element: HTMLElement,
  before: ComposerDraftState,
  next: ComposerDraftData,
  plugins: AgentPluginOption[],
  requested?: Selection,
): Selection | null {
  if (!editorMatchesDraft(element, before)) throw new Error('编辑器尚未同步当前草稿，请重新读取后操作')
  const old = units(before)
  const updated = units(next)
  let start = 0
  while (start < old.length && start < updated.length && key(old[start]) === key(updated[start])) start++
  let oldEnd = old.length
  let newEnd = updated.length
  while (oldEnd > start && newEnd > start && key(old[oldEnd - 1]) === key(updated[newEnd - 1])) {
    oldEnd--
    newEnd--
  }
  const previous = editorSelection(element)
  if (start === oldEnd && start === newEnd) {
    const focus = document.activeElement
    if (requested) setEditorSelection(element, requested)
    if (focus instanceof HTMLElement && focus !== element && focus.isConnected) focus.focus({ preventScroll: true })
    return requested ?? previous ?? before.selection
  }
  const focus = document.activeElement
  const selection = window.getSelection()
  const outside =
    selection?.anchorNode && selection.focusNode
      ? {
          anchor: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focus: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      : null
  const from = length(old.slice(0, start))
  const to = length(old.slice(0, oldEnd))
  const inserted = updated.slice(start, newEnd)
  const insertedLength = length(inserted)
  const move = (offset: number) =>
    offset <= from ? offset : offset >= to ? offset + insertedLength - (to - from) : from + insertedLength
  const original = previous ?? before.selection
  const restored = requested ?? (original ? { anchor: move(original.anchor), focus: move(original.focus) } : null)
  try {
    element.focus({ preventScroll: true })
    setEditorSelection(element, { anchor: from, focus: to })
    let applied: boolean
    if (inserted.every((part) => part.kind === 'text')) {
      applied = document.execCommand(
        'insertText',
        false,
        inserted.map((part) => (part.kind === 'text' ? part.text : '')).join(''),
      )
    } else {
      const container = document.createElement('div')
      container.append(...nodes(inserted, next, plugins))
      applied = document.execCommand('insertHTML', false, container.innerHTML)
    }
    if (!applied) throw new Error('浏览器未执行输入框编辑事务')
  } finally {
    if (restored && (previous || requested || focus === element)) setEditorSelection(element, restored)
    else if (outside?.anchor.isConnected && outside.focus.isConnected)
      selection?.setBaseAndExtent(outside.anchor, outside.anchorOffset, outside.focus, outside.focusOffset)
    if (focus instanceof HTMLElement && focus !== element && focus.isConnected) focus.focus({ preventScroll: true })
  }
  return restored
}
