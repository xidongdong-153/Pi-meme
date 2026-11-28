import type { BrowserTab } from './browser'
import type { SystemOperation } from './system-tools'

export const browserInteractionFeature = 'browser-interaction'
export const browserWaitDefaultMs = 10_000
export const browserWaitMaxMs = 30_000
export const browserBatchMaxSteps = 20
export const browserSnapshotLimits = {
  text: 40_000,
  elements: 150,
  maxElements: 300,
  optionsPerElement: 40,
  options: 300,
}

export const browserAgentKeys = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Space',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
] as const
export type BrowserAgentKey = (typeof browserAgentKeys)[number]

export type BrowserAgentSelectorTarget =
  | string
  | { elementId: string }
  | { css: string; nth?: number }
  | { role: string; name?: string; exact?: boolean; nth?: number }
  | { text: string; exact?: boolean; nth?: number }

export type BrowserAgentPointTarget = { x: number; y: number }
export type BrowserAgentTarget = BrowserAgentSelectorTarget | BrowserAgentPointTarget

export type BrowserReadOptions = {
  scope?: 'viewport' | 'full' | 'subtree'
  root?: BrowserAgentSelectorTarget
  frameId?: string
  cursor?: string
  maxElements?: number
  includeText?: boolean
}

export type BrowserSelectSingleOption = { value: string } | { label: string } | { index: number }
export type BrowserSelectOption = BrowserSelectSingleOption | BrowserSelectSingleOption[]

export type BrowserDialogInfo = {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultPrompt?: string
  url?: string
}

export type BrowserDomCondition = { documentId: number; state: 'visible' | 'hidden' } & (
  { kind: 'element'; role: string; name: string } | { kind: 'text'; text: string }
)

export type BrowserWaitCondition =
  | { kind: 'ready' }
  | { kind: 'url'; url: string }
  | { kind: 'loadState'; state: 'domcontentloaded' | 'load' }
  | { kind: 'networkIdle'; idleMs?: number }
  | { kind: 'download'; since?: string }
  | { kind: 'selector'; documentId?: number; target: BrowserAgentSelectorTarget; state: 'visible' | 'hidden' }
  | BrowserDomCondition

export type BrowserWaitObservation = { tabId: string; documentId: number; url: string; matched: boolean }
export type BrowserWaitResult = Omit<BrowserWaitObservation, 'matched'> & { status: 'matched' | 'timed-out' }

export type BrowserAgentElement = {
  id: string
  tag: string
  role: string | null
  name: string
  type: string | null
  value?: string
  href?: string
  rect?: { x: number; y: number; width: number; height: number }
  inViewport?: boolean
  scrollable?: boolean
  multiple?: boolean
  frameId?: string
  disabled: boolean
  readOnly: boolean
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  options?: { label: string; value?: string; selected: boolean; disabled: boolean }[]
  optionsTruncated?: boolean
}

export type BrowserAgentFrameSummary = {
  id: string
  url: string
  title?: string
  sameOrigin: boolean
}

export type BrowserAgentViewport = {
  width: number
  height: number
  scrollX: number
  scrollY: number
  scrollHeight: number
  scrollWidth: number
}

export type BrowserAgentPageSnapshot = {
  title: string
  text: string
  elements: BrowserAgentElement[]
  truncated: { text: boolean; elements: boolean }
  viewport: BrowserAgentViewport
  hasMoreBelow: boolean
  totalElements?: number
  nextCursor?: string
  frames?: BrowserAgentFrameSummary[]
  pendingDialog?: BrowserDialogInfo
}

export type BrowserAgentSnapshot = BrowserAgentPageSnapshot & {
  tab: Omit<BrowserTab, 'favicon'>
  documentId: number
}

export type BrowserActionReceipt = {
  tabId: string
  documentId: number
  delivery: 'delivered_unverified' | 'not_needed' | 'delivered_verified'
  openedTabs?: Array<{ tabId: string; url: string }>
  dialog?: BrowserDialogInfo
  scroll?: { x: number; y: number }
}

export type BrowserScrollInput =
  | number
  | {
      deltaX?: number
      deltaY?: number
      target?: BrowserAgentTarget
      to?: 'top' | 'bottom'
    }

export type BrowserPreparedUploadFile = {
  name: string
  dataBase64: string
  size: number
}

export type BrowserBatchStep =
  | {
      op: 'click'
      target: BrowserAgentTarget
      options?: { button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[] }
    }
  | { op: 'dblclick'; target: BrowserAgentTarget }
  | { op: 'hover'; target: BrowserAgentTarget }
  | { op: 'drag'; from: BrowserAgentTarget; to: BrowserAgentTarget }
  | { op: 'input'; target: BrowserAgentTarget; text: string; mode?: 'replace' | 'append' | 'type' }
  | { op: 'paste'; target?: BrowserAgentTarget | null; text: string; html?: string }
  | { op: 'press'; target?: BrowserAgentTarget | null; key: string }
  | { op: 'select'; target: BrowserAgentTarget; selection: BrowserSelectOption }
  | {
      op: 'scroll'
      delta?: number
      deltaX?: number
      deltaY?: number
      target?: BrowserAgentTarget
      to?: 'top' | 'bottom'
    }
  | { op: 'waitFor'; condition: BrowserWaitCondition; timeoutMs?: number }
  | { op: 'dialog'; action: 'accept' | 'dismiss'; promptText?: string }
  | { op: 'navigate'; url: string }
  | { op: 'back' }
  | { op: 'forward' }
  | { op: 'reload' }

function string(maxLength: number, minLength = 0) {
  return { type: 'string', maxLength, minLength }
}
const bool = { type: 'boolean' }
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum })
const num = (minimum = -100_000, maximum = 100_000) => ({ type: 'number', minimum, maximum })
function record(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false }
}
function optionalRecord(properties: Record<string, unknown>) {
  return record(properties, [])
}
const tabId = string(256, 1)
const documentId = int(0)
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

const selectorTarget = {
  oneOf: [
    elementId,
    record({ elementId }),
    record({ css: string(2048, 1), nth: int(-1000, 1000) }, ['css']),
    record({ role, name, exact: bool, nth: int(-1000, 1000) }, ['role']),
    record({ text: string(1000, 1), exact: bool, nth: int(-1000, 1000) }, ['text']),
  ],
}
const pointTarget = record({ x: num(0, 100_000), y: num(0, 100_000) })
const anyTarget = { oneOf: [selectorTarget, pointTarget] }
const nullableTarget = { anyOf: [anyTarget, { type: 'null' }] }

const readOptions = optionalRecord({
  scope: { enum: ['viewport', 'full', 'subtree'] },
  root: selectorTarget,
  frameId: string(256, 1),
  cursor: string(1024, 1),
  maxElements: int(1, browserSnapshotLimits.maxElements),
  includeText: bool,
})

const option = record({ label, value, selected: bool, disabled: bool }, ['label', 'selected', 'disabled'])
const rectSchema = record({
  x: num(-100_000, 100_000),
  y: num(-100_000, 100_000),
  width: num(0, 100_000),
  height: num(0, 100_000),
})
const element = record(
  {
    id: elementId,
    tag: string(128),
    role: nullable(role),
    name,
    type: nullable(string(64)),
    value,
    href: string(2048),
    rect: rectSchema,
    inViewport: bool,
    scrollable: bool,
    multiple: bool,
    frameId: string(256, 1),
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
    record({ kind: { enum: ['loadState'] }, state: { enum: ['domcontentloaded', 'load'] } }),
    record({ kind: { enum: ['networkIdle'] }, idleMs: int(100, 5000) }, ['kind']),
    record({ kind: { enum: ['download'] }, since: string(128, 1) }, ['kind']),
    record({ kind: { enum: ['selector'] }, documentId, target: selectorTarget, state }, ['kind', 'target', 'state']),
    record({ kind: { enum: ['element'] }, documentId, role, name, state }),
    record({ kind: { enum: ['text'] }, documentId, text: string(500, 1), state }),
  ],
}

const dialogSchema = record(
  {
    type: { enum: ['alert', 'confirm', 'prompt', 'beforeunload'] },
    message: string(4000),
    defaultPrompt: string(2000),
    url: string(2048),
  },
  ['type', 'message'],
)

const receipt = record(
  {
    tabId,
    documentId,
    delivery: { enum: ['delivered_unverified', 'not_needed', 'delivered_verified'] },
    openedTabs: { type: 'array', items: record({ tabId, url: string(2048) }) },
    dialog: dialogSchema,
    scroll: record({ x: num(-1_000_000, 1_000_000), y: num(-1_000_000, 1_000_000) }),
  },
  ['tabId', 'documentId', 'delivery'],
)

const waitResult = record({ tabId, documentId, url: { type: 'string' }, status: { enum: ['matched', 'timed-out'] } })

const singleSelectOption = {
  oneOf: [record({ value }), record({ label }), record({ index: int(0, 10_000) })],
}
const selectOptionSchema = {
  oneOf: [singleSelectOption, { type: 'array', items: singleSelectOption, maxItems: 200 }],
}

const scrollInputSchema = {
  oneOf: [
    num(-10_000, 10_000),
    optionalRecord({
      deltaX: num(-10_000, 10_000),
      deltaY: num(-10_000, 10_000),
      target: anyTarget,
      to: { enum: ['top', 'bottom'] },
    }),
  ],
}

const clickOptions = optionalRecord({
  button: { enum: ['left', 'middle', 'right'] },
  clickCount: int(1, 3),
  modifiers: { type: 'array', items: string(32, 1), maxItems: 4 },
})

const pageQuery = optionalRecord({
  cursor: string(4096, 1),
  offset: int(),
  limit: int(1, 100),
  revision: string(4096, 1),
})

const batchStepSchema = {
  oneOf: [
    record({ op: { enum: ['click'] }, target: anyTarget, options: clickOptions }, ['op', 'target']),
    record({ op: { enum: ['dblclick', 'hover'] }, target: anyTarget }),
    record({ op: { enum: ['drag'] }, from: anyTarget, to: anyTarget }),
    record(
      {
        op: { enum: ['input'] },
        target: anyTarget,
        text: string(100_000),
        mode: { enum: ['replace', 'append', 'type'] },
      },
      ['op', 'target', 'text'],
    ),
    record({ op: { enum: ['paste'] }, target: nullableTarget, text: string(100_000), html: string(100_000) }, [
      'op',
      'text',
    ]),
    record({ op: { enum: ['press'] }, target: nullableTarget, key: string(64, 1) }, ['op', 'key']),
    record({ op: { enum: ['select'] }, target: anyTarget, selection: selectOptionSchema }),
    record(
      {
        op: { enum: ['scroll'] },
        delta: num(-10_000, 10_000),
        deltaX: num(-10_000, 10_000),
        deltaY: num(-10_000, 10_000),
        target: anyTarget,
        to: { enum: ['top', 'bottom'] },
      },
      ['op'],
    ),
    record({ op: { enum: ['waitFor'] }, condition, timeoutMs: int(1, browserWaitMaxMs) }, ['op', 'condition']),
    record({ op: { enum: ['dialog'] }, action: { enum: ['accept', 'dismiss'] }, promptText: string(2000) }, [
      'op',
      'action',
    ]),
    record({ op: { enum: ['navigate'] }, url }),
    record({ op: { enum: ['back', 'forward', 'reload'] } }),
  ],
}

const snapshotSchema = record(
  {
    tab: { type: 'object' },
    documentId,
    title,
    text: string(browserSnapshotLimits.text),
    elements: { type: 'array', items: element, maxItems: browserSnapshotLimits.maxElements },
    truncated: record({ text: bool, elements: bool }),
    viewport: record({
      width: num(0, 100_000),
      height: num(0, 100_000),
      scrollX: num(-1_000_000, 1_000_000),
      scrollY: num(-1_000_000, 1_000_000),
      scrollHeight: num(0, 10_000_000),
      scrollWidth: num(0, 10_000_000),
    }),
    hasMoreBelow: bool,
    totalElements: int(),
    nextCursor: string(1024),
    frames: {
      type: 'array',
      items: record({ id: string(256, 1), url: string(2048), title: string(512), sameOrigin: bool }, [
        'id',
        'url',
        'sameOrigin',
      ]),
    },
    pendingDialog: dialogSchema,
  },
  ['tab', 'documentId', 'title', 'text', 'elements', 'truncated', 'viewport', 'hasMoreBelow'],
)

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

export const browserAgentOperations: SystemOperation[] = [
  operation(
    'read',
    '读取网页正文、控件、坐标、滚动状态、同源/跨域子帧与挂起弹窗；支持按视口、全页或子树局部读取与游标续读',
    '[tabId,{scope?:"viewport"|"full"|"subtree",root?,frameId?,cursor?,maxElements?,includeText?}?]',
    false,
    [tabId, readOptions],
    snapshotSchema,
    1,
  ),
  operation(
    'query',
    '按 CSS、role 或文字条件检索匹配元素并返回可操作 elementId 与坐标，适合大页面精确定位',
    '[tabId,target,{limit?}?]',
    false,
    [tabId, selectorTarget, optionalRecord({ limit: int(1, 50) })],
    record({ tabId, documentId, matches: { type: 'array', items: element } }),
    2,
  ),
  operation(
    'waitFor',
    '等待页面加载就绪、loadState、networkIdle、网址变化、下载完成，或元素/文字/选择器可见状态；上限 30000 毫秒',
    '[tabId,condition,{timeoutMs}?]',
    false,
    [tabId, condition, optionalRecord({ timeoutMs: int(1, browserWaitMaxMs) })],
    waitResult,
    2,
  ),
  operation(
    'console.list',
    '分页读取当前网页已捕获的控制台日志与未捕获异常（仅返回挂载调试会话后的记录）',
    '[tabId,{level?:"log"|"info"|"warn"|"error"|"debug",cursor?,offset?,limit?}?]',
    false,
    [
      tabId,
      optionalRecord({
        level: { enum: ['log', 'info', 'warn', 'error', 'debug'] },
        cursor: string(4096, 1),
        offset: int(),
        limit: int(1, 100),
      }),
    ],
    record(
      {
        items: { type: 'array' },
        total: int(),
        revision: string(256),
        nextCursor: string(4096),
        observedAt: string(128),
      },
      ['items', 'total', 'revision', 'observedAt'],
    ),
    1,
  ),
  operation(
    'network.list',
    '分页读取当前网页已捕获的脱敏网络请求摘要（不含 Cookie/Authorization/Body）',
    '[tabId,{failedOnly?,resourceType?,cursor?,offset?,limit?}?]',
    false,
    [
      tabId,
      optionalRecord({
        failedOnly: bool,
        resourceType: string(64, 1),
        cursor: string(4096, 1),
        offset: int(),
        limit: int(1, 100),
      }),
    ],
    record(
      {
        items: { type: 'array' },
        total: int(),
        revision: string(256),
        nextCursor: string(4096),
        observedAt: string(128),
      },
      ['items', 'total', 'revision', 'observedAt'],
    ),
    1,
  ),
  operation('back', '在网页历史中后退一页', '[tabId]', true, [tabId], { type: 'object' }),
  operation('forward', '在网页历史中前进一页', '[tabId]', true, [tabId], { type: 'object' }),
  operation('reload', '重新加载当前网页', '[tabId]', true, [tabId], { type: 'object' }),
  operation('activate', '将指定网页标签切换到前台可见', '[tabId]', true, [tabId], record({ activated: bool, tabId })),
  operation(
    'keepAlive',
    '开启或关闭网页标签的后台常驻运行（关闭后台节流并保持离屏 60fps 渲染，不抢占当前视图与焦点）',
    '[tabId,enabled]',
    true,
    [tabId, bool],
    record({ tabId, keepAlive: bool }),
  ),
  operation(
    'click',
    '自动滚入视口并发送真实鼠标点击；支持 elementId、CSS/role/text 选择器或坐标 {x,y}，支持左/中/右键、连击与修饰键',
    '[tabId,documentId,target,{button?,clickCount?,modifiers?}?]',
    true,
    [tabId, documentId, anyTarget, clickOptions],
    receipt,
    3,
  ),
  operation(
    'dblclick',
    '自动滚入视口并发送真实鼠标双击；支持选择器或坐标',
    '[tabId,documentId,target]',
    true,
    [tabId, documentId, anyTarget],
    receipt,
  ),
  operation(
    'hover',
    '自动滚入视口并移动鼠标悬停到目标元素或坐标（触发悬停菜单/Tooltip）',
    '[tabId,documentId,target]',
    true,
    [tabId, documentId, anyTarget],
    receipt,
  ),
  operation(
    'drag',
    '按住起点并拖拽移动到终点；支持选择器或坐标',
    '[tabId,documentId,fromTarget,toTarget]',
    true,
    [tabId, documentId, anyTarget, anyTarget],
    receipt,
  ),
  operation(
    'input',
    '聚焦输入控件或富文本编辑器并通过真实输入通道写入文本，兼容 React 受控组件与富文本；mode 可选 replace/append/type',
    '[tabId,documentId,target,text,{mode?:"replace"|"append"|"type"}?]',
    true,
    [tabId, documentId, anyTarget, string(100_000), optionalRecord({ mode: { enum: ['replace', 'append', 'type'] } })],
    receipt,
    4,
  ),
  operation(
    'paste',
    '向指定控件或当前焦点粘贴纯文本或 HTML 内容，不改写系统剪贴板',
    '[tabId,documentId,targetOrNull,{text,html?}]',
    true,
    [tabId, documentId, nullableTarget, record({ text: string(100_000), html: string(100_000) }, ['text'])],
    receipt,
  ),
  operation(
    'press',
    '向指定控件或当前页面发送键盘按键及组合键（如 Enter、Backspace、ControlOrMeta+k、Shift+Tab），后台标签也可用且不抢前台焦点',
    '[tabId,documentId,targetOrNull,key]',
    true,
    [tabId, documentId, nullableTarget, string(64, 1)],
    receipt,
  ),
  operation(
    'select',
    '选择原生单选或多选下拉项，支持 {value}/{label}/{index} 或多选数组（[] 清空）',
    '[tabId,documentId,target,selection]',
    true,
    [tabId, documentId, selectorTarget, selectOptionSchema],
    receipt,
  ),
  operation(
    'scroll',
    '滚动页面或指定内部可滚动容器，支持横向/纵向像素或跳至顶/底部',
    '[tabId,documentId,deltaY 或 {deltaX?,deltaY?,target?,to?}]',
    true,
    [tabId, documentId, scrollInputSchema],
    receipt,
  ),
  operation(
    'dialog',
    '处理当前网页挂起的 alert/confirm/prompt/beforeunload 原生弹窗',
    '[tabId,"accept"|"dismiss",promptText?]',
    true,
    [tabId, { enum: ['accept', 'dismiss'] }, string(2000)],
    record({ tabId, handled: bool, dialog: dialogSchema }, ['tabId', 'handled']),
    2,
  ),
  operation(
    'upload',
    '向文件输入控件或点击触发的文件选择器注入工作区内的相对路径文件（单文件<=16MiB，最多10个）',
    '[tabId,documentId,target,paths]',
    true,
    [tabId, documentId, anyTarget, { type: 'array', items: string(4096, 1), minItems: 1, maxItems: 10 }],
    receipt,
  ),
  operation(
    'downloads.saveToWorkspace',
    '将已完成的浏览器下载文件安全保存到当前会话工作区的指定相对路径（<=16MiB）',
    '[downloadId,relativePath]',
    true,
    [string(256, 1), string(4096, 1)],
    record({ savedPath: string(4096, 1), name: string(512), size: int() }),
  ),
  operation(
    'batch',
    '在单轮内顺序执行一组网页操作（最多 20 步），遇到跳转、弹窗或错误时立即中止并返回最新结果',
    '[tabId,steps,{stopOnError?,readAfter?}?]',
    true,
    [
      tabId,
      { type: 'array', items: batchStepSchema, minItems: 1, maxItems: browserBatchMaxSteps },
      optionalRecord({ stopOnError: bool, readAfter: { anyOf: [bool, readOptions] } }),
    ],
    record(
      {
        tabId,
        completedSteps: int(),
        totalSteps: int(),
        results: { type: 'array' },
        stoppedReason: string(512),
        snapshot: snapshotSchema,
      },
      ['tabId', 'completedSteps', 'totalSteps', 'results'],
    ),
    2,
  ),
  operation(
    'evaluate',
    '在页面主世界执行有界 JS 表达式并返回纯 JSON（需在「设置 → 浏览器」开启“允许 Agent 执行页面脚本”）',
    '[tabId,documentId,expression,arg?]',
    true,
    [tabId, documentId, string(32_000, 1), {}],
    record({ tabId, documentId, result: {} }, ['tabId', 'documentId']),
    3,
  ),
  operation(
    'fetch',
    '复用页面登录态发起 HTTP(S)/相对路径 fetch 请求（需在「设置 → 浏览器」开启“允许 Agent 执行页面脚本”）',
    '[tabId,documentId,url,{method?,headers?,body?,timeoutMs?}?]',
    true,
    [
      tabId,
      documentId,
      string(8192, 1),
      optionalRecord({
        method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
        headers: { type: 'object' },
        body: string(100_000),
        timeoutMs: int(100, 20_000),
      }),
    ],
    record(
      {
        ok: bool,
        status: int(),
        statusText: string(256),
        url: string(2048),
        headers: { type: 'object' },
        body: string(64_000),
        truncated: bool,
      },
      ['ok', 'status', 'statusText', 'url', 'headers', 'body'],
    ),
    3,
  ),
  operation(
    'handOff',
    '遇到登录、验证码、2FA 或网站权限确认时显式请求人工接管，自动切出该网页标签并展示原因与操作提示',
    '[tabId,{reason,actionHint?}]',
    true,
    [tabId, record({ reason: string(500, 1), actionHint: string(500, 1) }, ['reason'])],
    record({ handedOff: bool, tabId }),
  ),
]

export const browserInteractionOperations = new Set(
  browserAgentOperations.filter(({ name }) => name !== 'browser.read').map(({ name }) => name),
)

export { pageQuery as browserPageQuerySchema }
