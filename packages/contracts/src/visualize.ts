export type VisualizationRef = { id: string; revision: number }
export type VisualizationState = Record<string, string | number | boolean>
type ControlBase = { key: string; label: string }
export type VisualizationControl = ControlBase &
  (
    | { type: 'select'; options: { label: string; value: string }[] }
    | { type: 'toggle' }
    | { type: 'slider'; min: number; max: number; step?: number; unit?: string }
    | { type: 'color' }
  )
export type SaveVisualizationInput = {
  title: string
  description: string
  html: string
  initialState: VisualizationState
  controls: VisualizationControl[]
  reference?: VisualizationRef
}
export type VisualizationDocument = SaveVisualizationInput & {
  schemaVersion: 1
  id: string
  revision: number
  createdAt: string
  callId: string
}
export type VisualizationRequest =
  | { action: 'save'; input: SaveVisualizationInput; callId: string; references: VisualizationRef[] }
  | { action: 'read'; reference: VisualizationRef; references: VisualizationRef[] }

export function validateVisualizationRef(value: unknown): asserts value is VisualizationRef {
  const ref = value as VisualizationRef | undefined
  if (!ref || !/^[a-f0-9-]{36}$/.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1)
    throw new Error('草图引用无效')
}

export function validateVisualizationState(state: VisualizationState, input: SaveVisualizationInput) {
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    new TextEncoder().encode(JSON.stringify(state)).length > 16384
  )
    throw new Error('草图状态无效或超过 16 KiB')
  const keys = Object.keys(input.initialState)
  if (Object.keys(state).length !== keys.length) throw new Error('草图状态键不匹配')
  for (const key of keys) {
    const value = state[key]
    if (
      !Object.hasOwn(state, key) ||
      typeof value !== typeof input.initialState[key] ||
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error(`草图状态无效：${key}`)
  }
  for (const control of input.controls) {
    const value = state[control.key]
    if (control.type === 'toggle' && typeof value !== 'boolean') throw new Error('开关值无效')
    if (control.type === 'color' && (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)))
      throw new Error('颜色值无效')
    if (control.type === 'select' && !control.options.some((option) => option.value === value))
      throw new Error('下拉值无效')
    if (
      control.type === 'slider' &&
      (typeof value !== 'number' ||
        value < control.min ||
        value > control.max ||
        Math.abs(
          (value - control.min) / (control.step ?? 1) - Math.round((value - control.min) / (control.step ?? 1)),
        ) > 1e-7)
    )
      throw new Error('滑块值无效')
  }
}

export function validateVisualizationInput(value: unknown): asserts value is SaveVisualizationInput {
  if (!value || typeof value !== 'object') throw new Error('草图参数无效')
  const input = value as SaveVisualizationInput
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 120 ||
    typeof input.description !== 'string' ||
    !input.description.trim() ||
    input.description.length > 4000 ||
    typeof input.html !== 'string' ||
    !input.html.trim() ||
    new TextEncoder().encode(input.html).length > 1048576 ||
    !Array.isArray(input.controls) ||
    input.controls.length > 12 ||
    !input.initialState ||
    typeof input.initialState !== 'object' ||
    Array.isArray(input.initialState)
  )
    throw new Error('草图参数无效或超出大小限制')
  if (input.reference) validateVisualizationRef(input.reference)
  if (
    Object.keys(input.initialState).some(
      (key) => !/^[a-zA-Z][\w-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key),
    )
  )
    throw new Error('草图状态键无效')
  const used = new Set<string>()
  for (const c of input.controls) {
    if (
      !c ||
      !Object.hasOwn(input.initialState, c.key) ||
      used.has(c.key) ||
      typeof c.label !== 'string' ||
      !c.label.trim() ||
      !['select', 'toggle', 'slider', 'color'].includes(c.type)
    )
      throw new Error('草图控件无效')
    used.add(c.key)
    if (
      c.type === 'select' &&
      (!Array.isArray(c.options) ||
        !c.options.length ||
        c.options.length > 12 ||
        c.options.some((o) => !o || typeof o.label !== 'string' || typeof o.value !== 'string') ||
        new Set(c.options.map((o) => o.value)).size !== c.options.length)
    )
      throw new Error('下拉选项无效')
    if (
      c.type === 'slider' &&
      (![c.min, c.max, c.step ?? 1].every(Number.isFinite) || c.min >= c.max || (c.step ?? 1) <= 0)
    )
      throw new Error('滑块范围无效')
  }
  validateVisualizationState(input.initialState, input)
}

/** 输入必须为当前分支消息，不能传入全部会话树。 */
export function visualizationReferences(messages: readonly unknown[]): VisualizationRef[] {
  const refs: VisualizationRef[] = []
  for (const item of messages) {
    const m = item as { role?: string; toolName?: string; isError?: boolean; details?: { visualization?: unknown } }
    if (m.role !== 'toolResult' || m.toolName !== 'save_visualization' || m.isError) continue
    try {
      validateVisualizationRef(m.details?.visualization)
      refs.push(m.details!.visualization)
    } catch {
      /* 非有效草图结果不进入目录。 */
    }
  }
  return refs
}

export function visualizationMarkdown(ref: VisualizationRef) {
  return ['```visualize', JSON.stringify({ id: ref.id, revision: ref.revision }), '```'].join('\n')
}

export type VisualizationMessageContext = { reference: VisualizationRef; state: VisualizationState }
export function validateVisualizationContext(value: unknown): asserts value is VisualizationMessageContext {
  const context = value as VisualizationMessageContext
  if (!context || typeof context !== 'object') throw new Error('草图上下文无效')
  validateVisualizationRef(context.reference)
  validateVisualizationState(context.state, {
    initialState: context.state,
    controls: [],
  } as unknown as SaveVisualizationInput)
}
export function projectBranchVisualizations(
  entries: readonly { id: string; parentId: string | null; type: string; message?: unknown }[],
  leafId: string | null,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const messages: unknown[] = []
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    if (entry.type === 'message') messages.push(entry.message)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  return visualizationReferences(messages.reverse())
}
