import type { SystemOperation } from './system-tools'
import { readInteger, readPage, readRecord, type ReadQuery } from './system-read'

const pageSchema = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    query: { type: 'string', maxLength: 500 },
    cursor: { type: 'string', maxLength: 4096 },
    revision: { type: 'string' },
  },
  additionalProperties: false,
}
function clientInputSchema(name: string, parameters: string): Record<string, unknown> {
  if (parameters === '[]') return { type: 'array', maxItems: 0 }
  if (name.startsWith('composer.'))
    return {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        required: ['ref', 'revision'],
        properties: {
          ref: {
            type: 'object',
            required: ['id', 'epoch', 'target', 'context'],
            properties: {
              id: { type: 'string' },
              epoch: { type: 'integer', minimum: 0 },
              target: { type: 'object' },
              context: { type: 'object' },
              session: { type: 'object' },
            },
            additionalProperties: false,
          },
          revision: { type: 'integer', minimum: 0 },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 20000 },
        },
        additionalProperties: false,
      },
    }
  if (name === 'browser.annotations.get')
    return {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      prefixItems: [
        { type: 'string', minLength: 1, maxLength: 128 },
        {
          ...pageSchema,
          properties: {
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 20000 },
            revision: { type: 'string' },
          },
        },
      ],
      items: false,
    }
  if (parameters.includes('offset')) return { type: 'array', maxItems: 1, items: pageSchema }
  if (name === 'client.panels')
    return {
      type: 'array',
      maxItems: 1,
      items: {
        type: 'object',
        required: ['hostId', 'sessionId'],
        properties: { hostId: { type: 'string' }, sessionId: { type: 'string' } },
        additionalProperties: false,
      },
    }
  return {
    type: 'array',
    minItems: parameters.includes('?') ? 0 : 1,
    maxItems: 1,
    items: { type: 'string', minLength: 1, maxLength: 128 },
  }
}

/** Explicit, bounded client reads. This is not a generic RPC or object inspection API. */
export const clientReadDefinitions: readonly SystemOperation[] = [
  ['client.state', '读取发起客户端的有界界面状态', '[]'],
  ['client.navigation', '读取当前页面与导航可用性，不切换页面', '[]'],
  ['client.panels', '读取当前会话保留的面板布局与元数据，不挂载面板', '[SessionRef?]'],
  ['composer.status', '读取当前输入框引用、修订与状态，不包含草稿正文', '[]'],
  ['composer.read', '按明确输入框引用和修订分页读取草稿文档 JSON 正文', '[{ref,revision,offset?,limit?}]'],
  [
    'composer.attachments',
    '读取明确输入框的附件元数据与上传进度，不读取文件或图片正文',
    '[{ref,revision,offset?,limit?}]',
  ],
  ['composer.processing', '读取明确输入框的发送前处理状态，不执行处理器', '[{ref,revision}]'],
  ['browser.workspace', '读取当前执行会话的浏览器工作区摘要，不恢复或保存', '[]'],
  ['browser.annotations.list', '分页读取当前执行会话的网页批注摘要', '[{offset?,limit?}?]'],
  [
    'browser.annotations.get',
    '分页读取当前执行会话明确网页批注的 JSON 正文，不附带截图',
    '[annotationId,{offset?,limit?,revision?}?]',
  ],
  ['browser.annotations.image', '显式读取当前执行会话的网页批注截图', '[annotationId]'],
  ['browser.settings.get', '读取本地浏览器设置摘要，不返回下载目录路径', '[]'],
  ['browser.history.list', '分页读取本地浏览器档案的历史记录，不清除历史', '[{query?,offset?,limit?}?]'],
  ['browser.downloads.list', '分页读取本地浏览器档案的下载状态，不返回本机路径', '[{query?,offset?,limit?}?]'],
  ['browser.downloads.get', '读取明确下载状态，不打开文件或返回本机路径', '[downloadId]'],
  ['browser.permissions.list', '分页读取本地浏览器档案的网站权限', '[{query?,offset?,limit?}?]'],
  ['browser.data.status', '读取本地浏览器档案的数据统计，不读取 Cookie 或网站存储正文', '[]'],
  ['themes.list', '分页读取外观 Host 的主题目录摘要', '[{offset?,limit?}?]'],
  ['themes.get', '读取外观 Host 的明确主题', '[themeId]'],
  ['appearance.effective', '读取发起客户端的实际外观、系统偏好与修订', '[]'],
  ['shortcuts.list', '读取发起客户端的默认、自定义与实际快捷键', '[]'],
  [
    'client.connections.list',
    '读取发起客户端入口的连接摘要，不返回认证信息或触发重连',
    '[{offset?,limit?,cursor?,revision?}?]',
  ],
  ['client.connections.status', '读取发起客户端连接状态，不探测远端', '[serviceId?]'],
  ['client.ssh.capabilities', '读取客户端入口的 SSH 能力，不连接远端', '[]'],
  ['client.ssh.list', '读取客户端入口已缓存的 SSH 配置与连接阶段，不返回身份文件', '[]'],
  ['client.platform.capabilities', '读取本机平台可委托行为的支持状态，不执行原生操作', '[]'],
  ['client.projectApps.list', '读取本机可用的项目打开应用，不打开项目', '[]'],
  [
    'client.plugins.ui.list',
    '读取已加载且已授权的插件界面元数据，不运行渲染器或插件钩子',
    '[{offset?,limit?,cursor?,revision?}?]',
  ],
].map(([name, description, parameters]) => ({
  name,
  description,
  parameters,
  write: false,
  scope: 'client',
  domain: name.split('.')[0],
  inputSchema: clientInputSchema(name, parameters),
  outputSchema: { type: ['object', 'array'] },
  limits: { textBytes: 49152, maxPageSize: 100 },
}))
export const systemClientReadDefinitions = clientReadDefinitions

export const browserClientReadNames = clientReadDefinitions
  .filter((definition) => definition.name.startsWith('browser.'))
  .map((definition) => definition.name)

/** URLs in metadata must not disclose query credentials, fragments, or userinfo. */
export function systemMetadataUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

export type ClientReadPage = ReadQuery & { query?: string }
export function clientReadPage(value: unknown): ReadQuery & { offset: number; limit: number; query: string } {
  const input = readRecord(value, ['offset', 'limit', 'query', 'cursor', 'revision'])
  const offset = readInteger(input.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = readInteger(input.limit, 50, 100, 1)
  const query = input.query ?? ''
  if (typeof query !== 'string' || query.length > 500) throw new Error('读取筛选词无效')
  for (const field of ['cursor', 'revision'])
    if (input[field] !== undefined && (typeof input[field] !== 'string' || (input[field] as string).length > 4096))
      throw new Error('读取游标或修订无效')
  return {
    offset,
    limit,
    query,
    cursor: input.cursor as string | undefined,
    revision: input.revision as string | undefined,
  }
}

export function clientReadList<T>(items: readonly T[], value?: unknown, binding = 'client-read') {
  const page = clientReadPage(value)
  return readPage(items, page, `${binding}:${page.query}`)
}
