import type { ResourceItem } from '@pi-meme/contracts/resources'
import type { SystemOperation } from '@pi-meme/contracts/system-tools'
import type { ResourceStore } from '@pi-meme/resources/server/resource-store'
import {
  readPage,
  readRecord,
  readRevision,
  readString,
  readText,
  SystemReadError,
  type ReadQuery,
} from '@pi-meme/contracts/system-read'

const text = { type: 'string', minLength: 1, maxLength: 256 }
const target = {
  type: 'object',
  required: ['hostId', 'sessionId'],
  properties: { hostId: text, sessionId: text },
  additionalProperties: false,
}
const page = {
  type: 'object',
  properties: {
    cursor: { type: 'string', maxLength: 4096 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    revision: text,
  },
  additionalProperties: false,
}
const piece = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 20000 },
    revision: text,
  },
  additionalProperties: false,
}
const policy = {
  type: 'object',
  properties: { enabled: { type: 'boolean' }, invocation: { enum: ['automatic', 'manual'] } },
  additionalProperties: false,
}
const resourceSummary = {
  type: 'object',
  required: ['id', 'kind', 'name', 'revision', 'scope', 'owner', 'enabled', 'invocation', 'editable'],
  properties: {
    id: text,
    kind: { enum: ['skill', 'app-plugin'] },
    name: { type: 'string', maxLength: 160 },
    displayName: { type: 'string', maxLength: 240 },
    description: { type: 'string', maxLength: 240 },
    shortDescription: { type: 'string', maxLength: 240 },
    revision: text,
    scope: { enum: ['builtin', 'host', 'project'] },
    owner: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: text,
        type: { enum: ['loose', 'builtin', 'app-package'] },
        name: { type: 'string', maxLength: 160 },
        version: { type: 'string' },
        generation: { type: 'integer', minimum: 0 },
      },
    },
    enabled: { type: 'boolean' },
    invocation: { enum: ['automatic', 'manual'] },
    editable: { type: 'boolean' },
    defaultPolicy: policy,
    hostPolicy: policy,
    projectPolicy: policy,
    diagnosticCount: { type: 'integer', minimum: 0 },
    shadowedBy: text,
    fields: { type: 'array', items: { enum: ['name', 'description', 'shortDescription', 'diagnostics'] } },
  },
}
const pageResult = {
  type: 'object',
  required: ['items', 'total', 'revision', 'observedAt'],
  properties: {
    items: { type: 'array', items: resourceSummary },
    total: { type: 'integer', minimum: 0 },
    revision: text,
    nextCursor: { type: 'string' },
    observedAt: { type: 'string', format: 'date-time' },
  },
}
const pieceResult = {
  type: 'object',
  required: ['content', 'offset', 'total', 'revision', 'observedAt'],
  properties: {
    content: { type: 'string' },
    offset: { type: 'integer', minimum: 0 },
    total: { type: 'integer', minimum: 0 },
    revision: text,
    nextOffset: { type: 'integer', minimum: 0 },
    observedAt: { type: 'string', format: 'date-time' },
  },
}
const definitions: Array<[string, string, string, Record<string, unknown>[], number, Record<string, unknown>]> = [
  [
    'resources.catalog',
    '分页读取技能和插件资源目录及调用策略，不生成执行快照',
    '[{kind?,scope?,cursor?,offset?,limit?,revision?}?,SessionRef?]',
    [
      {
        ...page,
        properties: {
          ...page.properties,
          kind: { enum: ['skill', 'app-plugin'] },
          scope: { enum: ['builtin', 'host', 'project'] },
        },
      },
      target,
    ],
    0,
    pageResult,
  ],
  [
    'resources.detail',
    '读取资源策略及来源摘要；长名称、说明和诊断按字段分片读取',
    '[id,{field?:name|description|shortDescription|diagnostics,offset?,limit?,revision?}?,SessionRef?]',
    [
      text,
      {
        ...piece,
        properties: {
          ...piece.properties,
          field: { enum: ['name', 'description', 'shortDescription', 'diagnostics'] },
        },
      },
      target,
    ],
    1,
    {
      anyOf: [
        resourceSummary,
        {
          type: 'object',
          required: ['id', 'field', 'piece'],
          properties: { id: text, field: text, piece: pieceResult },
        },
      ],
    },
  ],
  [
    'resources.readSkill',
    '显式分片读取技能入口正文，不初始化或物化资源',
    '[id,{offset?,limit?,revision?}?,SessionRef?]',
    [text, piece, target],
    1,
    { ...pieceResult, properties: { ...pieceResult.properties, item: resourceSummary } },
  ],
  [
    'resources.files',
    '按资源 ID 和修订分页列出技能包内文件，仅返回相对路径和大小',
    '[id,revision,{cursor?,offset?,limit?,revision?}?,SessionRef?]',
    [text, text, page, target],
    2,
    {
      ...pageResult,
      properties: {
        ...pageResult.properties,
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['relativePath', 'size', 'kind'],
            properties: {
              relativePath: { type: 'string', minLength: 1, maxLength: 4096 },
              size: { type: 'integer', minimum: 0, maximum: 32 * 1024 * 1024 },
              kind: { const: 'file' },
            },
          },
        },
      },
    },
  ],
  [
    'resources.file',
    '按资源 ID、修订和包内相对路径分片读取 UTF-8 文件，二进制返回不支持',
    '[id,revision,relativePath,{offset?,limit?,revision?}?,SessionRef?]',
    [text, text, { type: 'string', minLength: 1, maxLength: 4096 }, piece, target],
    3,
    {
      anyOf: [
        {
          ...pieceResult,
          properties: {
            ...pieceResult.properties,
            kind: { const: 'text' },
            relativePath: { type: 'string', minLength: 1, maxLength: 4096 },
          },
        },
        {
          type: 'object',
          required: ['kind', 'reason', 'relativePath', 'revision', 'size'],
          properties: {
            kind: { const: 'unsupported' },
            reason: { const: 'binary-or-encoding' },
            relativePath: { type: 'string', minLength: 1, maxLength: 4096 },
            revision: text,
            size: { type: 'integer', minimum: 0 },
          },
        },
      ],
    },
  ],
]

export const systemResourceReadDefinitions: SystemOperation[] = definitions.map(
  ([name, description, parameters, prefixItems, minItems, outputSchema]) => ({
    name,
    description,
    parameters,
    write: false,
    scope: 'session',
    domain: 'resources',
    inputSchema: { type: 'array', prefixItems, minItems, maxItems: prefixItems.length },
    outputSchema,
    limits: { textBytes: 48 * 1024, maxPageSize: 100 },
  }),
)

function summary(item: ResourceItem) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name.slice(0, 160),
    displayName: item.displayName?.slice(0, 240),
    description: item.description?.slice(0, 240),
    shortDescription: item.shortDescription?.slice(0, 240),
    revision: item.revision,
    scope: item.scope,
    owner: {
      id: item.owner.id,
      type: item.owner.type,
      name: item.owner.name?.slice(0, 160),
      version: item.owner.version,
      generation: item.owner.generation,
    },
    enabled: item.enabled,
    invocation: item.invocation,
    editable: item.editable,
    defaultPolicy: item.defaultPolicy,
    hostPolicy: item.hostPolicy,
    projectPolicy: item.projectPolicy,
    shadowedBy: item.shadowedBy,
    diagnosticCount: item.diagnostics.length,
    fields: ['name', 'description', 'shortDescription', 'diagnostics'],
  }
}

/** resolveCwd must validate an explicit target against the active execution before returning its directory. */
export function createResourceReads(
  resources: ResourceStore,
  resolveCwd: (target?: unknown) => string | Promise<string>,
) {
  return {
    async read(operation: string, args: unknown[]) {
      const definition = definitions.find(([name]) => name === operation)
      if (!definition) throw new SystemReadError('not-supported', '资源读取操作不存在')
      if (args.length < definition[4] || args.length > definition[3].length)
        throw new SystemReadError('invalid-input', '资源读取参数数量无效')
      if (operation === 'resources.catalog') {
        const query = readRecord(args[0], ['kind', 'scope', 'cursor', 'offset', 'limit', 'revision'], '资源目录查询')
        if (query.kind !== undefined && query.kind !== 'skill' && query.kind !== 'app-plugin')
          throw new SystemReadError('invalid-input', '资源类型无效')
        if (query.scope !== undefined && !['builtin', 'host', 'project'].includes(query.scope as string))
          throw new SystemReadError('invalid-input', '资源作用域无效')
        const cwd = await resolveCwd(args[1])
        const catalog = await resources.peekCatalog(cwd)
        const items = catalog.items
          .filter((item) => (!query.kind || item.kind === query.kind) && (!query.scope || item.scope === query.scope))
          .map(summary)
        return {
          ...readPage(
            items,
            query as ReadQuery,
            JSON.stringify([catalog.hostId, catalog.cwd, query.kind ?? null, query.scope ?? null]),
            readRevision([catalog.generation, items]),
          ),
          generation: catalog.generation,
          diagnosticCount: catalog.diagnostics.length,
        }
      }
      const id = readString(args[0], '资源 ID', 256)
      if (operation === 'resources.files') {
        const query = readRecord(args[2], ['cursor', 'offset', 'limit', 'revision'], '资源文件查询') as ReadQuery
        return resources.listFiles(id, readString(args[1], '资源修订', 256), query, await resolveCwd(args[3]))
      }
      if (operation === 'resources.file') {
        const query = readRecord(args[3], ['offset', 'limit', 'revision'], '资源正文查询') as ReadQuery
        return resources.readFilePiece(
          id,
          readString(args[1], '资源修订', 256),
          readString(args[2], '资源相对路径', 4096),
          query,
          await resolveCwd(args[4]),
        )
      }
      const query = readRecord(args[1], ['field', 'offset', 'limit', 'revision'], '资源详情查询') as ReadQuery & {
        field?: string
      }
      const cwd = await resolveCwd(args[2])
      if (operation === 'resources.readSkill') {
        if (query.field !== undefined) throw new SystemReadError('invalid-input', '技能正文查询不接受字段选择')
        const value = await resources.readSkill(id, cwd)
        return { ...readText(value.content, query, value.item.revision), item: summary(value.item) }
      }
      const item = await resources.detail(id, cwd)
      if (query.revision !== undefined && query.revision !== item.revision)
        throw new SystemReadError('stale-cursor', '资源已变化，请重新读取')
      if (query.field === undefined) return summary(item)
      if (!['name', 'description', 'shortDescription', 'diagnostics'].includes(query.field))
        throw new SystemReadError('invalid-input', '资源详情字段无效')
      const content =
        query.field === 'diagnostics'
          ? item.diagnostics.join('\n')
          : (item[query.field as 'name' | 'description' | 'shortDescription'] ?? '')
      return { id: item.id, field: query.field, piece: readText(content, query, item.revision) }
    },
  }
}
