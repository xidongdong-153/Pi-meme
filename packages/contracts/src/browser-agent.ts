import type { BrowserTab } from './browser'
import type { SystemOperation } from './system-tools'

export const browserInteractionFeature = 'browser-interaction'
export const browserWaitDefaultMs = 10_000
export const browserWaitMaxMs = 20_000
export const browserSnapshotLimits = { text: 40_000, elements: 150, optionsPerElement: 40, options: 300 }
export const browserAgentKeys = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Space',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
] as const
export type BrowserAgentKey = (typeof browserAgentKeys)[number]
export type BrowserSelectOption = { value: string } | { label: string }
export type BrowserDomCondition = { documentId: number; state: 'visible' | 'hidden' } & (
  { kind: 'element'; role: string; name: string } | { kind: 'text'; text: string }
)
export type BrowserWaitCondition = { kind: 'ready' } | { kind: 'url'; url: string } | BrowserDomCondition
export type BrowserWaitObservation = { tabId: string; documentId: number; url: string; matched: boolean }
export type BrowserWaitResult = Omit<BrowserWaitObservation, 'matched'> & { status: 'matched' | 'timed-out' }
export type BrowserAgentElement = {
  id: string
  tag: string
  role: string | null
  name: string
  type: string | null
  value?: string
  disabled: boolean
  readOnly: boolean
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  options?: { label: string; value?: string; selected: boolean; disabled: boolean }[]
  optionsTruncated?: boolean
}
export type BrowserAgentPageSnapshot = {
  title: string
  text: string
  elements: BrowserAgentElement[]
  truncated: { text: boolean; elements: boolean }
}
export type BrowserAgentSnapshot = BrowserAgentPageSnapshot & { tab: Omit<BrowserTab, 'favicon'>; documentId: number }
export type BrowserActionReceipt = {
  tabId: string
  documentId: number
  delivery: 'delivered_unverified' | 'not_needed'
}

function string(maxLength: number, minLength = 0) {
  return { type: 'string', maxLength, minLength }
}
const bool = { type: 'boolean' }
function record(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false }
}
const tabId = string(256, 1)
const documentId = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const elementId = string(128, 1)
const role = string(64, 1)
const name = string(300)
const url = string(8192, 1)
const label = string(300)
const value = string(1024)
const title = string(512)
function nullable(schema: object) {
  return { anyOf: [schema, { type: 'null' }] }
}
const option = record({ label, value, selected: bool, disabled: bool }, ['label', 'selected', 'disabled'])
const element = record(
  {
    id: elementId,
    tag: string(128),
    role: nullable(role),
    name,
    type: nullable(string(64)),
    value,
    disabled: bool,
    readOnly: bool,
    checked: { anyOf: [bool, { enum: ['mixed'] }] },
    selected: bool,
    expanded: bool,
    options: { type: 'array', items: option, maxItems: browserSnapshotLimits.optionsPerElement },
    optionsTruncated: bool,
  },
  ['id', 'tag', 'role', 'name', 'type'],
)
const state = { enum: ['visible', 'hidden'] }
const condition = {
  oneOf: [
    record({ kind: { enum: ['ready'] } }),
    record({ kind: { enum: ['url'] }, url }),
    record({ kind: { enum: ['element'] }, documentId, role, name, state }),
    record({ kind: { enum: ['text'] }, documentId, text: string(500, 1), state }),
  ],
}
const receipt = record({ tabId, documentId, delivery: { enum: ['delivered_unverified', 'not_needed'] } })
const waitResult = record({ tabId, documentId, url: { type: 'string' }, status: { enum: ['matched', 'timed-out'] } })

function operation(
  name: string,
  description: string,
  parameters: string,
  write: boolean,
  prefixItems: object[],
  outputSchema: Record<string, unknown>,
  minItems = prefixItems.length,
): SystemOperation {
  return {
    name: `browser.${name}`,
    description,
    parameters,
    write,
    scope: 'client',
    domain: 'browser',
    inputSchema: { type: 'array', prefixItems, minItems, maxItems: prefixItems.length },
    outputSchema,
  }
}

export const browserAgentOperations = [
  operation(
    'read',
    '读取主文档可见文字、控件角色、名称、状态与下拉选项；返回本次可操作的元素引用',
    '[tabId]',
    false,
    [tabId],
    record(
      {
        tab: { type: 'object' },
        documentId,
        title,
        text: string(browserSnapshotLimits.text),
        elements: { type: 'array', items: element, maxItems: browserSnapshotLimits.elements },
        truncated: record({ text: bool, elements: bool }),
      },
      ['tab', 'documentId', 'title', 'text', 'elements'],
    ),
  ),
  operation(
    'press',
    '在处于前台的 Desktop 窗口内向指定网页控件发送按键，可操作后台标签；操作后回读页面',
    '[tabId,documentId,elementId,key]',
    true,
    [tabId, documentId, elementId, { enum: browserAgentKeys }],
    receipt,
  ),
  operation(
    'select',
    '按精确的值或显示标签选择原生单选下拉项；重名或禁用时返回错误',
    '[tabId,documentId,elementId,{value} 或 {label}]',
    true,
    [tabId, documentId, elementId, { oneOf: [record({ value }), record({ label })] }],
    receipt,
  ),
  operation(
    'waitFor',
    '等待已加载标签就绪、到达指定来源和路径，或观察当前文档中元素或文字的可见状态',
    '[tabId,condition,{timeoutMs}?]；默认 10000 毫秒，上限 20000 毫秒',
    false,
    [tabId, condition, record({ timeoutMs: { type: 'integer', minimum: 1, maximum: browserWaitMaxMs } }, [])],
    waitResult,
    2,
  ),
]

export const browserInteractionOperations = new Set(
  browserAgentOperations.filter(({ name }) => name !== 'browser.read').map(({ name }) => name),
)
