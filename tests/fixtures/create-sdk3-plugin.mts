import { lstat, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlugin } from '@pi-meme/plugin-devkit/create'
import { buildPlugin, validatePlugin } from '@pi-meme/plugin-devkit/build'

export const sdk3SmokePluginId = 'sdk3-smoke-workspace'
const marker = 'tests/fixtures/create-sdk3-plugin.mts'

const sharedSource = String.raw`import type { JsonValue } from '@pi-meme/plugin-sdk/rpc'
export type WorkspaceReport = {
  pluginId: string
  generation: number
  runnerPid: number
  files: string[]
  note: string | null
  shared: { status: string; revision: number; value: JsonValue }
}
export const reportSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    pluginId: { type: 'string' }, generation: { type: 'integer' }, runnerPid: { type: 'integer' },
    files: { type: 'array', items: { type: 'string' } }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    shared: { type: 'object', additionalProperties: false, properties: { status: { type: 'string' }, revision: { type: 'integer' }, value: {} }, required: ['status', 'revision', 'value'] },
  }, required: ['pluginId', 'generation', 'runnerPid', 'files', 'note', 'shared'],
}
`

const restrictedServerSource = String.raw`import { readdir, readFile, stat } from 'node:fs/promises'
import type { RestrictedServerContext } from '@pi-meme/plugin-sdk/restricted'
import { reportSchema, type WorkspaceReport } from '../shared/report'
export function create(context: RestrictedServerContext) {
  return { dispose: context.registerOperations([{
    name: 'workspaceReport',
    inputSchema: { type: 'object', properties: { includeShared: { type: 'boolean' } }, required: ['includeShared'], additionalProperties: false },
    outputSchema: reportSchema, audience: ['agent'], effect: 'read', capabilities: ['workspace.read'],
    execute: async (input) => {
      const report: WorkspaceReport = {
        pluginId: context.pluginId, generation: context.generation, runnerPid: process.pid,
        files: (await readdir('.')).sort().slice(0, 100), note: null,
        shared: { status: 'not-requested', revision: 0, value: null },
      }
      try {
        const file = './sdk3-smoke-note.txt'
        report.note = (await stat(file)).size <= 8192 ? await readFile(file, 'utf8') : '样例文件超过 8192 字节，未读取。'
      } catch { report.note = null }
      if ((input as { includeShared: boolean }).includeShared) {
        try {
          const snapshot = await context.sharedData.read('catalog')
          report.shared = { status: 'available', revision: snapshot.revision, value: snapshot.value }
        } catch { report.shared.status = 'not-granted-or-unpublished' }
      }
      return report
    },
  }]) }
}
`

const restrictedAgentSource = String.raw`import type { RestrictedAgentContext } from '@pi-meme/plugin-sdk/restricted'
import type { WorkspaceReport } from '../shared/report'
export function activate(context: RestrictedAgentContext) {
  context.tools.register({
    name: 'sdk3_smoke_read_workspace', title: 'SDK3 工作区只读报告',
    description: '读取当前工作区文件名和固定样例文本；可选读取获准的 catalog 共享数据。不写文件、不访问公网。',
    parameters: { type: 'object', properties: { includeShared: { type: 'boolean' } }, required: ['includeShared'], additionalProperties: false },
    effect: 'read', capabilities: ['workspace.read'],
    execute: async (input, execution) => {
      const report = await context.server.call<WorkspaceReport>('workspaceReport', { includeShared: input.includeShared === true }, { signal: execution.signal })
      const data = { ...report, agentPid: process.pid, sameProcess: report.runnerPid === process.pid }
      await context.messages.emit({ type: 'workspace-report', text: 'SDK3 工作区只读报告', data })
      return { text: JSON.stringify(data), data }
    },
  })
}
`

const trustedServerSource = String.raw`import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'
export function create(context: ServerPluginContext) {
  context.registerOperations([
    {
      name: 'overview', inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pluginId: { type: 'string' }, generation: { type: 'integer' }, origin: { type: 'string' }, projectId: { anyOf: [{ type: 'string' }, { type: 'null' }] }, catalogRevision: { type: 'integer' }, timestamp: { type: 'string' } }, required: ['pluginId', 'generation', 'origin', 'projectId', 'catalogRevision', 'timestamp'], additionalProperties: false },
      audience: ['ui'], effect: 'read', capabilities: [],
      execute: async (_input, call) => {
        const projectId = call.target.project?.projectId ?? null
        const snapshot = await context.sharedData.getSnapshot('catalog', { scope: projectId ?? undefined })
        return { pluginId: context.pluginId, generation: context.generation, origin: call.origin, projectId, catalogRevision: snapshot?.revision ?? 0, timestamp: new Date().toISOString() }
      },
    },
    {
      name: 'publishCatalog',
      inputSchema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 120 }, expectedRevision: { type: 'integer', minimum: 0 } }, required: ['label', 'expectedRevision'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: {}, revision: { type: 'integer' } }, required: ['value', 'revision'], additionalProperties: false },
      audience: ['ui'], effect: 'external-write', capabilities: [],
      execute: async (input, call) => {
        const value = input as { label: string; expectedRevision: number }
        const scope = call.target.project?.projectId
        const result = await context.sharedData.publish('catalog', { label: value.label, publisher: context.pluginId, scope: scope ?? 'plugin-global' }, { scope, expectedRevision: value.expectedRevision })
        return result
      },
    },
  ])
}
`

const uiSource = String.raw`import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { UiPluginContext, UiContributionProps } from '@pi-meme/plugin-sdk/ui'
import type { UiPageProps } from '@pi-meme/plugin-sdk/navigation'

type Message = NonNullable<UiContributionProps['message']>
type Metadata = ReturnType<UiPluginContext['reactive']['getSnapshot']>['messages'][number]
type Overview = { pluginId: string; generation: number; origin: string; projectId: string | null; catalogRevision: number; timestamp: string }
const sectionStyle = { padding: 20, display: 'grid', gap: 12, maxWidth: 960 }
const preStyle = { whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, padding: 12, border: '1px solid currentColor', borderRadius: 8, fontSize: 12 }
function Json({ value }: { value: unknown }) { return <pre style={preStyle}>{JSON.stringify(value, null, 2)}</pre> }
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function Icon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 4h16v16H4zM4 10h16M10 10v10" /></svg> }
function currentComposer(context: UiPluginContext) { try { return context.composer.current() } catch { return null } }
function useComposer(context: UiPluginContext) {
  const view = currentComposer(context)
  const ref = view?.ref
  const subscribe = useMemo(() => (listener: () => void) => ref ? context.composer.subscribe(ref, listener) : () => {}, [context, ref?.id, ref?.epoch])
  return useSyncExternalStore(subscribe, () => currentComposer(context), () => null)
}
function Controls({ context }: { context: UiPluginContext }) {
  const view = useComposer(context)
  const [message, setMessage] = useState('')
  const pending = useRef(new Set<AbortController>())
  useEffect(() => () => { for (const request of pending.current) request.abort(); pending.current.clear() }, [])
  async function append(text: string) {
    const source = context.composer.current()
    if (!source) throw new Error('请先返回首页聊天；插件页面不会操作隐藏的旧输入框。')
    const end = source.document.reduce((size, part) => size + (part.kind === 'text' ? part.text.length : 1), 0)
    const result = await context.composer.apply(source.ref, { expectedRevision: source.revision, steps: [{ kind: 'replace', from: end, to: end, content: [{ kind: 'text', text: (end ? '\n' : '') + text }] }] })
    if (result.status === 'rejected') throw new Error(result.reason)
    setMessage('已插入唯一草稿，尚未发送。')
  }
  async function upload(files: File[]) {
    const source = context.composer.current()
    if (!source) throw new Error('请先打开聊天输入框。')
    const request = new AbortController()
    pending.current.add(request)
    try {
      const result = await context.composer.addAttachments(source.ref, files.map((file) => ({ name: file.name, data: file })), { signal: request.signal })
      if (!request.signal.aborted && result.status === 'rejected') throw new Error(result.reason)
      if (!request.signal.aborted) setMessage('附件通过宿主正常上传；下方仅显示不透明引用和状态。')
    } finally { pending.current.delete(request) }
  }
  const run = (task: () => Promise<void>) => { void task().catch((cause) => setMessage(errorText(cause))) }
  return <div style={{ display: 'grid', gap: 8 }}>
    <strong>SDK3 草稿与附件演示</strong>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" onClick={() => run(() => append('请调用 sdk3_smoke_read_workspace，includeShared=false，读取当前工作区，只报告 JSON 和 sameProcess，不修改文件。'))}>插入只读检索模板</button>
      <button type="button" onClick={() => run(() => append('请调用 sdk3_smoke_read_workspace，includeShared=true，读取当前工作区与已获准的 catalog，只报告 JSON，不修改文件。'))}>插入共享读取模板</button>
      <button type="button" onClick={() => run(() => append('[阻止] 这条草稿用于演示主动阻断与仅本次跳过。'))}>插入阻断样例</button>
      <button type="button" onClick={() => run(() => append('[重试] 这条草稿首次校验失败，同一次发送点击重试会通过。'))}>插入重试样例</button>
      <button type="button" onClick={() => run(() => append('[规范化] 发送前移除这个显式标记。'))}>插入改写样例</button>
      <label>实际选择附件 <input type="file" multiple disabled={!view?.editable} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) run(() => upload(files)) }} /></label>
    </div>
    <small>只插入，不自动发送。需要先在插件授权页开启 composer 能力；发送前校验还须单独开启 validate-smoke。</small>
    {view && <><span>草稿修订 {view.revision}；epoch {view.ref.epoch}；{view.composing ? '输入法组合中' : view.submissionState}</span><Json value={view.attachments} /></>}
    {message && <p role="status">{message}</p>}
  </div>
}
function StandardMessage({ message }: { message: Message | null | undefined }) {
  if (!message) return <p>标准消息尚未提交；不读取 raw Pi 数据。</p>
  return <div><strong>SDK3 标准 UiMessage 报告</strong><Json value={{ role: message.role, ref: message.ref, source: message.source, state: message.state, data: message.data ?? { text: message.text } }} /></div>
}
function ReportMessage({ context, metadata, signal }: { context: UiPluginContext; metadata: Metadata; signal?: AbortSignal }) {
  const [message, setMessage] = useState<Message | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!metadata.ref) return
    void context.messages.getMessage(metadata.ref).then((value) => { if (!cancelled && !signal?.aborted) { setMessage(value); setError('') } }, (cause) => { if (!cancelled && !signal?.aborted) setError(errorText(cause)) })
    return () => { cancelled = true }
  }, [context, metadata.ref?.entryId, metadata.revision, signal])
  return error ? <p role="alert">{error}</p> : <StandardMessage message={message} />
}
function Reports({ context, signal, toolOnly = false }: { context: UiPluginContext; signal?: AbortSignal; toolOnly?: boolean }) {
  const snapshot = useSyncExternalStore(context.reactive.subscribe, context.reactive.getSnapshot, context.reactive.getSnapshot)
  const reports = snapshot.messages.filter((message) => message.ref && message.source?.ownerId === context.pluginId && message.source.generation === context.generation && (toolOnly ? message.role === 'tool' && message.toolName === 'sdk3_smoke_read_workspace' : message.toolName === 'sdk3_smoke_read_workspace' || message.customType === 'workspace-report')).slice(toolOnly ? -1 : -10)
  return <>{reports.length ? reports.map((message) => <ReportMessage key={message.id} context={context} metadata={message} signal={signal} />) : <p>尚无同来源报告。回到聊天，选择本插件并显式调用只读工具。索引只显示当前代次；正文由 messages.getMessage 按需读取。</p>}</>
}
function OverviewPage({ context, page }: { context: UiPluginContext; page: UiPageProps }) {
  const metadata = useSyncExternalStore(context.reactive.metadata.subscribe, context.reactive.metadata.getSnapshot, context.reactive.metadata.getSnapshot)
  const [server, setServer] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  return <section style={sectionStyle}><h2>SDK3 概览</h2><p>页面目标固定在打开时；返回首页才有可操作的输入框。</p><Json value={{ pluginId: context.pluginId, generation: context.generation, pageTarget: page.target, reactive: metadata }} />
    <button type="button" onClick={() => { void context.server.call<Overview>('overview', {}, { target: page.target, signal: page.signal }).then((value) => { if (!page.signal.aborted) { setServer(value); setError('') } }, (cause) => { if (!page.signal.aborted) setError(errorText(cause)) }) }}>读取可信 Server JSON</button>
    {server && <Json value={server} />}{error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => context.navigation.back()}>返回上一页</button>
  </section>
}
function SettingsPage({ context, page }: { context: UiPluginContext; page: UiPageProps }) {
  const [label, setLabel] = useState('本插件显式发布的非敏感目录说明')
  const [revision, setRevision] = useState<number | null>(null)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState('')
  useEffect(() => { void context.server.call<Overview>('overview', {}, { target: page.target, signal: page.signal }).then((value) => { if (!page.signal.aborted) setRevision(value.catalogRevision) }, (cause) => { if (!page.signal.aborted) setError(errorText(cause)) }) }, [context, page.signal, page.target])
  return <section style={sectionStyle}><h2>SDK3 设置与显式共享发布</h2>
    <p>授权在宿主的“插件 → 个人 → SDK3 组合验收”中操作。安装不授信，也不会自动开启发送前处理。</p>
    <p>此表单只发布 catalog 命名 JSON；没有凭据读取或任意 Host 文件写入。共享记录只在 Host 内存中，重启需重新发布。</p>
    <label>共享说明 <input value={label} maxLength={120} onChange={(event) => { setLabel(event.currentTarget.value); page.page.setUnsavedChanges(true) }} /></label>
    <button type="button" disabled={revision === null || !label.trim()} onClick={() => { void context.server.call<{ revision: number; value: unknown }>('publishCatalog', { label: label.trim(), expectedRevision: revision! }, { target: page.target, signal: page.signal }).then((value) => { if (!page.signal.aborted) { setRevision(value.revision); setResult(value); setError(''); page.page.setUnsavedChanges(false) } }, (cause) => { if (!page.signal.aborted) setError(errorText(cause)) }) }}>经宿主确认后发布 catalog</button>
    {result !== null && <Json value={result} />}{error && <p role="alert">{error}</p>}
    <p>开启 sharedData.read 与 catalog 后，回到聊天让工具 includeShared=true。HTTP 只声明 example.com 的 GET/HEAD，本样例不会发起网络请求。</p>
  </section>
}
export function activate(context: UiPluginContext) {
  const disposers: Array<() => void | Promise<void>> = []
  const own = (dispose: () => void | Promise<void>) => { disposers.push(dispose) }
  const downloads = new Set<string>()
  let lastRetryAttempt = ''
  own(context.composer.beforeSend.register({
    id: 'validate-smoke', title: 'SDK3 显式发送前校验', order: 10,
    process({ attemptId, draft }) {
      const text = draft.document.filter((part) => part.kind === 'text').map((part) => part.text).join('')
      if (text.includes('[阻止]')) return { kind: 'block', reason: '检测到显式 [阻止] 标记。草稿已保留，可查看、重试，或由宿主确认仅本次跳过。' }
      if (text.includes('[重试]') && lastRetryAttempt !== attemptId) { lastRetryAttempt = attemptId; throw new Error('演示一次临时失败。点击同一次发送的重试即可通过；仅本次跳过也可继续。') }
      if (text.includes('[规范化]')) return { kind: 'replace', input: { document: draft.document.map((part) => part.kind === 'text' ? { ...part, text: part.text.replaceAll('[规范化]', '') } : part), attachmentIds: [...draft.attachmentIds] } }
      return { kind: 'pass' }
    },
  }))
  own(context.contributions.register({ id: context.pluginId + ':composer', slot: 'composer-actions', title: 'SDK3 草稿演示', render: () => <Controls context={context} /> }))
  own(context.contributions.register({ id: context.pluginId + ':tool', slot: 'tool-card', title: 'SDK3 工具报告', match: { toolName: 'sdk3_smoke_read_workspace' }, render: () => <Reports context={context} toolOnly /> }))
  own(context.contributions.register({ id: context.pluginId + ':report', slot: 'message', title: 'SDK3 自定义报告', match: { customType: 'workspace-report' }, render: ({ message }) => <StandardMessage message={message} /> }))
  const pages: Array<[string, string, (props: UiPageProps) => ReactNode]> = [
    ['overview', '概览', (props) => <OverviewPage context={context} page={props} />],
    ['reports', '报告', (props) => <section style={sectionStyle}><h2>同来源标准消息报告</h2><Reports context={context} signal={props.signal} /></section>],
    ['settings', '设置', (props) => <SettingsPage context={context} page={props} />],
  ]
  for (const [id, title, render] of pages) own(context.pages.register({ id: context.pluginId + ':' + id, title, scope: 'app', render }))
  own(context.navigation.register({ title: 'SDK3 组合验收', icon: <Icon />, defaultPageId: context.pluginId + ':overview', groups: [{ id: 'smoke', title: '临时验收', items: pages.map(([id, title]) => ({ id, title, pageId: context.pluginId + ':' + id })) }] }))
  own(context.messageActions.register({
    id: context.pluginId + ':quote', title: 'SDK3 引用到当前草稿', match: { roles: ['user', 'assistant', 'tool', 'custom'], source: 'any' },
    execute: async ({ subject, target, messages, signal }) => {
      const view = context.composer.current()
      if (!view || !view.ref.session || view.ref.session.sessionId !== target.session?.sessionId || view.ref.session.hostId !== target.hostId) throw new Error('请先返回消息所属聊天；不会自动向隐藏或其他会话草稿写入。')
      if (signal.aborted) return
      const body = subject.displayedText || messages.map((message) => message.text).join('\n')
      const quoted = body.slice(0, 8000).split('\n').map((line) => '> ' + line).join('\n') + (body.length > 8000 ? '\n（引用已截断，完整标准消息可用导出动作。）' : '')
      const end = view.document.reduce((size, part) => size + (part.kind === 'text' ? part.text.length : 1), 0)
      const result = await context.composer.apply(view.ref, { expectedRevision: view.revision, steps: [{ kind: 'replace', from: end, to: end, content: [{ kind: 'text', text: '\n引用 ' + subject.role + '，条目 ' + subject.refs.map((ref) => ref.entryId).join(', ') + '\n' + quoted + '\n' }] }] })
      if (result.status === 'rejected') throw new Error(result.reason)
    },
  }))
  own(context.messageActions.register({
    id: context.pluginId + ':export', title: 'SDK3 导出标准消息 JSON', match: { roles: ['user', 'assistant', 'tool', 'custom'], source: 'any' },
    execute: ({ subject, messages, signal }) => {
      if (signal.aborted) return
      const url = URL.createObjectURL(new Blob([JSON.stringify({ subject, messages }, null, 2)], { type: 'application/json' }))
      downloads.add(url)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'sdk3-message-' + subject.role + '.json'; anchor.click()
      setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url) }, 1000)
    },
  }))
  return async () => { for (const url of downloads) URL.revokeObjectURL(url); downloads.clear(); for (const dispose of disposers.reverse()) await dispose() }
}
`

const readme = `# SDK3 组合验收临时插件

插件 ID：\`${sdk3SmokePluginId}\`。生成源码和构建产物都在 out/sdk3-smoke/plugin，不会自动安装或授权。

## 显式准备

1. 在隔离 Host 中加载此构建目录。不要复用个人数据根、真实凭据或历史会话。
2. 在宿主插件详情显式信任 UI，授予所需 UI 能力；需要 Server JSON 与共享发布时，再单独信任可信 Server。无 trusted Agent 入口。
3. 在隔离项目 out/sdk3-smoke/workspace 中选择本插件，允许 restricted read-only 与 workspace.read。
4. 发送前校验默认关闭。单独开启 validate-smoke 后，聊天中的阻断/重试/规范化样例才会执行。普通发送使用宿主原按钮，插件不申请 composer.submit。
5. 附件必须由用户通过聊天内的实际文件选择器选择，走正常上传队列；不写入伪造的 opaque 引用。
6. 阻断、重试、规范化样例分别在独立草稿中验收；存在 [阻止] 时会始终优先阻断，重试不会自动删除该标记。

## 本地假模型准备（由验收者启动，本 builder 不启动服务）

1. 用受管前台进程启动：pnpm exec tsx tests/fixtures/sdk3-smoke-provider.mts。它只启动本地假 provider，并准备 out/sdk3-smoke/host/pi/models.json 与 test-credentials.json；后者仅含固定 test 假密钥。
2. 再运行独立 Host：PI_MEME_DATA_ROOT=\"$PWD/out/sdk3-smoke/host\" PI_MEME_TEST_CREDENTIALS=memory PI_MEME_TOKEN=sdk3-smoke-local-only PI_MEME_PORT=40213 pnpm run start:server。40213 若被占用应显式另选端口，不复用真实 Host。
3. 浏览器入口：PI_MEME_HOST_URL=http://127.0.0.1:40213 pnpm run start:web。浏览器显式选择 fake/first，并登记本样例 workspace；不要导入真实服务商或个人历史。
4. 受限执行使用验收者已校验的官方 Node；例如单独设置 PI_MEME_PLUGIN_NODE 指向 out/sdk3-smoke/runtime/bin/node。此 builder 不下载或替换运行时。

provider 入口复用 fake-agent.mjs，models.json 只声明 loopback OpenAI 兼容 fake 服务。PI_MEME_TEST_CREDENTIALS=memory 让 Host 只读取隔离的测试凭据 seed，不读取个人凭据文件。停止假 provider 后需重新启动它并重启隔离 Host，以更新随机 loopback 端口。此准备脚本不会安装插件或创建会话。

## 六项组合展示

- 输入框：聊天下方显式按钮追加模板、实际附件上传、CAS 与 opaque 附件元数据。不从插件页面写隐藏输入框。
- 受限执行：sdk3_smoke_read_workspace -> 同进程 restricted Server -> 工作区文件名与固定 sdk3-smoke-note.txt；不写文件。返回 agentPid/runnerPid/sameProcess 供实际运行核对。
- Agent/Server：受限工具只调用受限 Server；可信 Server 只开放 UI overview 与用户确认后的 publishCatalog，不向 Agent 开放。
- 消息动作：user/assistant/tool/custom 均有引用到同一聊天草稿与标准 JSON 下载动作。
- 响应式：概览显示 reactive metadata；报告页与自有工具卡片按原生引用按需取得 UiMessage；自定义卡片也只使用标准 UiMessage。
- 左侧：每插件一个图标，概览/报告/设置一层菜单；设置表单 dirty/保存使用宿主生命周期，返回首页恢复聊天。

## 共享、网络和边界

设置页显式发布非敏感 catalog；授权 sharedData.read 与 catalog 后，工具参数 includeShared=true 才尝试读取。缺授权或未发布会返回 not-granted-or-unpublished。记录只在 Host 内存，重启需重新发布。

HTTP 仅声明 https://example.com 的 GET/HEAD，样例不访问公网、不读取凭据，也不需要网络授权；地址、授权和连接参数由专门测试验证，不将 resolver/transport spy 写成公网成功请求证据。

构建/校验仅证明产物可生成，不证明浏览器交互、真实模型工具调用、OS 拒写、更新撤权或跨 Host 已验收。运行中更新、撤权、断线与返回聊天需要验收者逐项操作；不可把本 builder 的成功当成全部运行通过。
`

export async function createSdk3SmokePlugin(root = path.resolve(import.meta.dirname, '../..')) {
  const directory = path.join(root, 'out/sdk3-smoke/plugin')
  const workspace = path.join(root, 'out/sdk3-smoke/workspace')
  await mkdir(path.dirname(directory), { recursive: true })
  try {
    const existing = await lstat(directory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('样例输出位置不是普通目录')
    const ownedMarker = path.join(directory, '.sdk3-smoke-fixture')
    const markerFile = await lstat(ownedMarker).catch(() => null)
    const savedMarker = markerFile?.isFile() ? await readFile(ownedMarker, 'utf8').catch(() => '') : ''
    if (savedMarker !== marker) throw new Error('输出目录已存在，且不是本 builder 生成的样例')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    await createPlugin(directory, sdk3SmokePluginId)
    await writeFile(path.join(directory, '.sdk3-smoke-fixture'), marker)
  }
  const base = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as Awaited<
    ReturnType<typeof createPlugin>
  >
  if (base.name !== sdk3SmokePluginId) throw new Error('样例目录的插件身份已变化，拒绝覆盖')
  const manifest: typeof base = {
    ...base,
    name: sdk3SmokePluginId,
    version: '0.1.0',
    description: '在隔离 Host 中组合验收 SDK3 输入框、受限工具、同代 RPC、消息动作、响应式数据与左侧页面。',
    piMeme: {
      sdkVersion: 3,
      display: { name: 'SDK3 组合验收' },
      ui: 'dist/ui/entry.js',
      agent: { restricted: 'dist/agent/restricted.js' },
      server: { restricted: 'dist/server/restricted.js', trusted: 'dist/server/chord-facets.json' },
      permissions: {
        ui: [
          'composer.read',
          'composer.write',
          'composer.attachments',
          'composer.before-send',
          'reactive.read',
          'messages.read',
          'messages.actions',
          'navigation.pages',
        ],
        beforeSend: ['validate-smoke'],
        restricted: {
          maxAccess: 'read-only',
          capabilities: ['workspace.read', 'sharedData.read', 'http.request'],
          sharedData: ['catalog'],
          network: [{ id: 'smoke-example', origin: 'https://example.com', methods: ['GET', 'HEAD'] }],
        },
      },
    },
  }
  const files = {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({ extends: path.relative(directory, path.join(root, 'tsconfig.json')), compilerOptions: { noEmit: true }, include: ['src'] }, null, 2)}\n`,
    'src/shared/report.ts': sharedSource,
    'src/agent/restricted.ts': restrictedAgentSource,
    'src/server/restricted.ts': restrictedServerSource,
    'src/server/entry.ts': trustedServerSource,
    'src/ui/entry.tsx': uiSource,
    'README.md': readme,
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const dependencies = path.join(directory, 'node_modules')
  try {
    if ((await lstat(dependencies)).isSymbolicLink()) {
      if ((await realpath(dependencies)) !== (await realpath(path.join(root, 'node_modules'))))
        throw new Error('样例 node_modules 已指向其他位置')
      await unlink(dependencies)
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  await mkdir(path.join(dependencies, '@pi-meme'), { recursive: true })
  const sdkLink = path.join(dependencies, '@pi-meme/plugin-sdk')
  const sdk = path.join(root, 'packages/plugin-sdk')
  try {
    if ((await realpath(sdkLink)) !== (await realpath(sdk))) throw new Error('样例 SDK 链接已指向其他位置')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    await symlink(sdk, sdkLink, 'dir')
  }
  const note = '这是 SDK3 组合验收的临时工作区样例。插件只读此文件，不访问真实凭据、模型或会话。\n'
  const workspaceMarker = path.join(workspace, '.sdk3-smoke-fixture')
  const noteFile = path.join(workspace, 'sdk3-smoke-note.txt')
  try {
    const existing = await lstat(workspace)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('临时工作区不是普通目录')
    const markerFile = await lstat(workspaceMarker).catch(() => null)
    const savedMarker = markerFile?.isFile() ? await readFile(workspaceMarker, 'utf8').catch(() => '') : ''
    if (savedMarker !== marker) {
      const entries = await readdir(workspace)
      const noteStat = await lstat(noteFile).catch(() => null)
      const initialGeneratedWorkspace =
        entries.length === 1 &&
        entries[0] === 'sdk3-smoke-note.txt' &&
        noteStat?.isFile() &&
        (await readFile(noteFile, 'utf8').catch(() => '')) === note
      if (!initialGeneratedWorkspace) throw new Error('工作区已存在，且不是本 builder 生成的样例，拒绝覆盖')
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    await mkdir(workspace, { recursive: true })
  }
  await writeFile(workspaceMarker, marker)
  try {
    await writeFile(noteFile, note, { flag: 'wx' })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(noteFile)).isFile()) throw cause
  }
  await buildPlugin(directory)
  await validatePlugin(directory)
  return { pluginId: sdk3SmokePluginId, directory, workspace, installed: false, granted: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  createSdk3SmokePlugin()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : String(cause))
      process.exitCode = 1
    })
}
