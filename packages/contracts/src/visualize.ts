import type { SystemOperation } from './system-tools'
import { piNestedInteractionEntryType, readPiNestedInteractionEntry } from './pi'

export type VisualizationRef = { id: string; revision: number }
export type VisualizationState = Record<string, string | number | boolean>
export type VisualizationEnvironment = {
  appearance: 'light' | 'dark'
  reducedMotion: boolean
  visible: boolean
  fontFamily: string
  fontSize: number
  radius: number
  colors: Record<string, string>
}
export type VisualizationPreviewState = {
  reference: VisualizationRef
  state: VisualizationState
  source: 'live' | 'saved' | 'initial'
}
export type VisualizationExportFormat = 'png' | 'html'
export type VisualizationExportResult = {
  status: 'download-started'
  fileName: string
  mimeType: string
}
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
  layout?: 'regular' | 'wide'
  libraries?: 'echarts'[]
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  )
}

export function validateVisualizationRef(value: unknown): asserts value is VisualizationRef {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['id', 'revision'].includes(key)) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  )
    throw new Error('可视化引用无效')
}

export function validateVisualizationState(
  state: unknown,
  input: SaveVisualizationInput,
): asserts state is VisualizationState {
  if (!isRecord(state)) throw new Error('可视化状态无效')
  const keys = Object.keys(input.initialState)
  if (Object.keys(state).length !== keys.length) throw new Error('可视化状态键不匹配')
  for (const key of keys) {
    const value = state[key]
    if (
      !Object.hasOwn(state, key) ||
      typeof value !== typeof input.initialState[key] ||
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error(`可视化状态无效：${key}`)
  }
  if (new TextEncoder().encode(JSON.stringify(state)).length > 16384) throw new Error('可视化状态超过 16 KiB')
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
  if (!isRecord(value)) throw new Error('可视化参数无效')
  // Store.read 也使用此校验；旧版文档保留原 schemaVersion，不填充新字段。
  const documentKeys = ['schemaVersion', 'id', 'revision', 'createdAt', 'callId']
  const document = Object.hasOwn(value, 'schemaVersion')
  const keys = ['title', 'description', 'html', 'initialState', 'controls', 'reference', 'layout', 'libraries']
  if (document) keys.push(...documentKeys)
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('可视化参数包含未知字段')
  if (document) {
    validateVisualizationRef({ id: value.id, revision: value.revision })
    if (value.schemaVersion !== 1 || typeof value.createdAt !== 'string' || typeof value.callId !== 'string')
      throw new Error('可视化文档无效')
  }
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
    !isRecord(input.initialState)
  )
    throw new Error('可视化参数无效或超出大小限制')
  if (input.layout !== undefined && input.layout !== 'regular' && input.layout !== 'wide')
    throw new Error('可视化布局必须为 regular 或 wide')
  if (
    input.libraries !== undefined &&
    (!Array.isArray(input.libraries) ||
      input.libraries.length > 1 ||
      [...input.libraries].some((library) => library !== 'echarts') ||
      new Set(input.libraries).size !== input.libraries.length)
  )
    throw new Error('可视化库只支持 echarts，且不能重复')
  if (document) {
    if (input.reference) {
      // 旧工具结果可带 title，历史文档曾将其连同 reference 保存；只投影校验，不改写文档。
      const reference = isRecord(input.reference)
        ? { id: input.reference.id, revision: input.reference.revision }
        : input.reference
      validateVisualizationRef(reference)
    }
  } else if (input.reference !== undefined) validateVisualizationRef(input.reference)
  if (
    Object.keys(input.initialState).some(
      (key) => !/^[a-zA-Z][\w-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key),
    )
  )
    throw new Error('可视化状态键无效')
  const used = new Set<string>()
  for (const c of input.controls) {
    if (
      !isRecord(c) ||
      Object.keys(c).some((key) => !['type', 'key', 'label', 'options', 'min', 'max', 'step', 'unit'].includes(key)) ||
      typeof c.key !== 'string' ||
      !Object.hasOwn(input.initialState, c.key) ||
      used.has(c.key) ||
      typeof c.label !== 'string' ||
      !c.label.trim() ||
      !['select', 'toggle', 'slider', 'color'].includes(c.type)
    )
      throw new Error('可视化控件无效')
    used.add(c.key)
    if (
      c.type === 'select' &&
      (!Array.isArray(c.options) ||
        !c.options.length ||
        c.options.length > 12 ||
        c.options.some(
          (o) =>
            !isRecord(o) ||
            Object.keys(o).some((key) => !['label', 'value'].includes(key)) ||
            typeof o.label !== 'string' ||
            typeof o.value !== 'string',
        ) ||
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
  const seen = new Set<string>()
  for (const item of messages) {
    if (!isRecord(item)) continue
    const m = item as { role?: string; toolName?: string; isError?: boolean; details?: { visualization?: unknown } }
    if (m.role !== 'toolResult' || m.toolName !== 'save_visualization' || m.isError) continue
    try {
      const value = m.details?.visualization
      if (!isRecord(value)) continue
      // details.visualization 兼带 title 等元数据，分支引用只保留 id 与 revision。
      const reference = { id: value.id, revision: value.revision }
      validateVisualizationRef(reference)
      const key = `${reference.id}:${reference.revision}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(reference)
    } catch {
      /* 非有效可视化结果不进入目录。 */
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
  if (!isRecord(context) || Object.keys(context).some((key) => !['reference', 'state'].includes(key)))
    throw new Error('可视化上下文无效')
  validateVisualizationRef(context.reference)
  validateVisualizationState(context.state, {
    initialState: context.state,
    controls: [],
  } as unknown as SaveVisualizationInput)
}
export function projectBranchVisualizations(
  entries: readonly {
    id: string
    parentId: string | null
    type: string
    message?: unknown
    customType?: string
    data?: unknown
  }[],
  leafId: string | null,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const messages: unknown[] = []
  let entry = leafId ? byId.get(leafId) : undefined
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id)
    if (entry.type === 'message') messages.push(entry.message)
    if (entry.type === 'custom' && entry.customType === piNestedInteractionEntryType) {
      const nested = readPiNestedInteractionEntry(entry.data)
      if (nested?.interaction.name === 'save_visualization' && nested.interaction.status === 'success')
        messages.push({
          role: 'toolResult',
          toolName: 'save_visualization',
          isError: false,
          details: nested.interaction.result.details,
        })
    }
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  return visualizationReferences(messages.reverse())
}

export const visualizationRefSchema = {
  type: 'object',
  required: ['id', 'revision'],
  properties: {
    id: {
      type: 'string',
      minLength: 36,
      maxLength: 36,
      pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
    },
    revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
  additionalProperties: false,
}

/** 固定执行会话与发起客户端；既不接受路径，也不接受其他客户端或会话目标。 */
export const visualizationClientOperationDefinitions: readonly SystemOperation[] = [
  {
    name: 'visualizations.previewState',
    description: '读取当前执行会话可访问的可视化预览状态，注明 live、saved 或 initial 来源；不打开面板',
    parameters: '[{id,revision}]',
    write: false,
    scope: 'client',
    domain: 'visualizations',
    inputSchema: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      prefixItems: [visualizationRefSchema],
      items: false,
    },
    outputSchema: {
      type: 'object',
      required: ['reference', 'state', 'source'],
      properties: {
        reference: visualizationRefSchema,
        state: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        source: { type: 'string', enum: ['live', 'saved', 'initial'] },
      },
      additionalProperties: false,
    },
    limits: { textBytes: 49152, retained: '状态最多 16 KiB；每次读取重新校验当前分支访问权限' },
  },
  {
    name: 'visualizations.export',
    description: '在发起客户端下载当前执行会话可访问的可视化 PNG 或 HTML；PNG 未挂载返回 not-loaded，不打开面板',
    parameters: '[{id,revision},{format:"png"|"html"}]',
    write: true,
    scope: 'client',
    domain: 'visualizations',
    inputSchema: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      prefixItems: [
        visualizationRefSchema,
        {
          type: 'object',
          required: ['format'],
          properties: { format: { type: 'string', enum: ['png', 'html'] } },
          additionalProperties: false,
        },
      ],
      items: false,
    },
    outputSchema: {
      type: 'object',
      required: ['status', 'fileName', 'mimeType'],
      properties: {
        status: { type: 'string', enum: ['download-started'] },
        fileName: { type: 'string', minLength: 1, maxLength: 255 },
        mimeType: { type: 'string', enum: ['image/png', 'text/html'] },
      },
      additionalProperties: false,
    },
    limits: { textBytes: 49152, retained: '仅返回下载已发起的元数据，不返回本机路径或图片正文' },
  },
]
