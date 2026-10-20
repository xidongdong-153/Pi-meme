import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ComposerSelection } from '@pi-meme/plugin-sdk/composer'
import type { ComposerAttachment } from './image-attachment'
import { movePluginPositions } from './editor-plugin-tokens'

type Update<T> = T | ((value: T) => T)
export type ComposerDraftData = {
  draft: string
  selectedSkills: PiSlashCommand[]
  pluginMentions: string[]
  pluginAnchors: Record<string, number>
  attachments: ComposerAttachment[]
  queueMode: 'steering' | 'followUp'
}
export type ComposerDraftState = ComposerDraftData & {
  revision: number
  selection: ComposerSelection | null
  selectionRevision: number
  composing: boolean
}

export type ComposerDraftAction =
  | { type: 'patch'; patch: Partial<ComposerDraftData> }
  | { type: 'composition'; composing: boolean }
  | { type: 'selection'; selection: { anchor: number; focus: number } | null }

export function composerDraftReducer(previous: ComposerDraftState, action: ComposerDraftAction): ComposerDraftState {
  if (action.type === 'composition')
    return previous.composing === action.composing ? previous : { ...previous, composing: action.composing }
  if (action.type === 'selection') {
    const selection = action.selection
    if (previous.selection?.anchor === selection?.anchor && previous.selection?.focus === selection?.focus)
      return previous
    const revision = previous.selectionRevision + 1
    return { ...previous, selectionRevision: revision, selection: selection && { ...selection, revision } }
  }
  const patch = action.patch
  if (Object.entries(patch).every(([key, value]) => previous[key as keyof ComposerDraftData] === value)) return previous
  let pluginAnchors = patch.pluginAnchors ?? previous.pluginAnchors
  if (patch.draft !== undefined && patch.draft !== previous.draft && !patch.pluginAnchors) {
    const positions = new Map(Object.entries(pluginAnchors))
    movePluginPositions(positions, previous.draft, patch.draft)
    pluginAnchors = Object.fromEntries(positions)
  }
  const next = { ...previous, ...patch, pluginAnchors, revision: previous.revision + 1 }
  next.pluginAnchors = Object.fromEntries([
    ...Object.entries(pluginAnchors).map(([id, offset]) => [id, Math.max(0, Math.min(offset, next.draft.length))]),
    ...next.pluginMentions.filter((id) => pluginAnchors[id] === undefined).map((id) => [id, 0]),
  ])
  return next
}

export class ComposerDraftStore {
  private value: ComposerDraftState = {
    draft: '',
    selectedSkills: [],
    pluginMentions: [],
    pluginAnchors: {},
    attachments: [],
    queueMode: 'followUp',
    revision: 0,
    selection: null,
    selectionRevision: 0,
    composing: false,
  }
  private readonly listeners = new Set<() => void>()
  editor: {
    focus: (selection?: { anchor: number; focus: number }) => void
    applyEdit: (
      next: ComposerDraftData,
      selection?: { anchor: number; focus: number },
    ) => { anchor: number; focus: number } | null
  } | null = null
  getSnapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(value: ComposerDraftState) {
    this.value = value
    for (const listener of this.listeners) listener()
  }
  dispatch = (action: ComposerDraftAction) => {
    const next = composerDraftReducer(this.value, action)
    if (next !== this.value) this.publish(next)
  }
  patch = (patch: Partial<ComposerDraftData>) => this.dispatch({ type: 'patch', patch })
  applyEdit = (patch: Partial<ComposerDraftData>, selection?: { anchor: number; focus: number }) => {
    if (this.value.composing) throw new Error('请先完成输入法组合输入')
    const current = this.value
    const nextSelection = this.editor?.applyEdit({ ...current, ...patch }, selection)
    this.patch(patch)
    if (selection || nextSelection) this.setSelection(selection ?? nextSelection!)
  }
  setDraft = (update: Update<string>) =>
    this.patch({ draft: typeof update === 'function' ? update(this.value.draft) : update })
  setSelectedSkills = (update: Update<PiSlashCommand[]>) =>
    this.patch({ selectedSkills: typeof update === 'function' ? update(this.value.selectedSkills) : update })
  setPluginMentions = (update: Update<string[]>) =>
    this.patch({ pluginMentions: typeof update === 'function' ? update(this.value.pluginMentions) : update })
  setAttachments = (update: Update<ComposerAttachment[]>) =>
    this.patch({ attachments: typeof update === 'function' ? update(this.value.attachments) : update })
  setQueueMode = (update: Update<ComposerDraftData['queueMode']>) =>
    this.patch({ queueMode: typeof update === 'function' ? update(this.value.queueMode) : update })
  setPluginAnchors = (pluginAnchors: Record<string, number>) => {
    if (JSON.stringify(pluginAnchors) !== JSON.stringify(this.value.pluginAnchors)) this.patch({ pluginAnchors })
  }
  setComposing = (composing: boolean) => this.dispatch({ type: 'composition', composing })
  setSelection = (selection: { anchor: number; focus: number } | null) =>
    this.dispatch({ type: 'selection', selection })
}
