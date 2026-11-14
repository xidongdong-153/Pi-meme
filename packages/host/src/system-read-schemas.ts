import type { SystemOperation } from '@pi-meme/contracts/system-tools'
import { contextPartKinds } from '@pi-meme/contracts/context-window'
import { visualizationClientOperationDefinitions, visualizationRefSchema } from '@pi-meme/contracts/visualize'

type Schema = Record<string, unknown>
const text = (maxLength = 256, minLength = 1): Schema => ({ type: 'string', minLength, maxLength })
const integer = (maximum = Number.MAX_SAFE_INTEGER, minimum = 0): Schema => ({ type: 'integer', minimum, maximum })
function record(properties: Record<string, unknown>, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false }
}
function tuple(prefixItems: Schema[], minItems = 0): Schema {
  return { type: 'array', prefixItems, minItems, maxItems: prefixItems.length }
}
const ref = (key: string) => record({ hostId: text(128), [key]: text(256) }, ['hostId', key])
const session = ref('sessionId')
const project = ref('projectId')
const workspace = { oneOf: [session, project] }
const page = { cursor: text(4096), offset: integer(), limit: integer(100, 1), revision: text(4096) }
const piece = { offset: integer(), limit: integer(20000, 1), revision: text(4096) }
const gitQuery = { scope: { enum: ['uncommitted', 'unstaged', 'staged', 'commit', 'branch'] }, ref: text(1024) }

/** Schemas for original and directly registered reads; domain readers declare their own schemas. */
export function systemReadInputSchema(name: string): SystemOperation['inputSchema'] {
  const visualizationClientOperation = visualizationClientOperationDefinitions.find((entry) => entry.name === name)
  if (visualizationClientOperation) return visualizationClientOperation.inputSchema
  if (
    [
      'projects.list',
      'models.list',
      'schedules.list',
      'schedules.schema',
      'plugins.defaults',
      'profile.get',
      'profile.avatar',
      'usage.get',
      'mcp.get',
      'instructions.get',
      'resources.list',
      'commands.list',
      'appearance.get',
      'browser.list',
      'host.capabilities',
      'memory.status',
    ].includes(name)
  )
    return tuple([])
  if (['projects.get', 'projects.deletePreview'].includes(name)) return tuple([project], 1)
  if (name === 'sessions.list') return tuple([record({ project })])
  if (
    [
      'sessions.get',
      'sessions.attention',
      'plans.list',
      'visualizations.list',
      'git.availability',
      'activities.list',
      'agents.list',
      'goals.get',
    ].includes(name)
  )
    return tuple([session])
  if (name === 'sessions.messages') return tuple([record({ ...page, limit: integer(500, 1) }), session])
  if (name === 'sessions.submissions') return tuple([record(page), session])
  if (name === 'sessions.receipt') return tuple([text()], 1)
  if (name === 'terminal.list') return tuple([record(page)])
  if (name === 'terminal.read') return tuple([text(128)], 1)
  if (['memory.list', 'memory.search'].includes(name))
    return tuple(
      [
        record(
          { query: text(500), cursor: text(4096), limit: integer(20, 1) },
          name === 'memory.search' ? ['query'] : [],
        ),
      ],
      name === 'memory.search' ? 1 : 0,
    )
  if (name === 'memory.get') return tuple([text()], 1)
  if (name === 'memory.sources') return tuple([text(), record(page)], 1)
  if (name === 'schedules.get') return tuple([ref('taskId')], 1)
  if (name === 'schedules.runs') return tuple([ref('taskId'), record({ offset: integer(), limit: integer(200, 1) })], 1)
  if (name === 'images.list')
    return tuple([
      record({
        origin: { enum: ['all', 'generated', 'uploaded'] },
        projectId: text(),
        query: text(500),
        cursor: text(4096),
        limit: integer(100, 1),
      }),
    ])
  if (['images.get', 'images.read', 'browser.read', 'browser.screenshot'].includes(name)) return tuple([text()], 1)
  if (name === 'visualizations.read') return tuple([visualizationRefSchema, session], 1)
  if (name === 'files.list') return tuple([text(4096, 0), workspace])
  if (['files.read', 'files.preview'].includes(name)) return tuple([text(4096), workspace], 1)
  if (name === 'files.search') return tuple([record({ query: text(500), cursor: text(4096) }, ['query']), workspace], 1)
  if (name === 'files.listPage') return tuple([record({ ...page, relativePath: text(4096, 0) }), workspace])
  if (name === 'files.readPiece')
    return tuple([record({ ...piece, relativePath: text(4096) }, ['relativePath']), workspace], 1)
  if (['git.snapshot', 'git.environment'].includes(name)) return tuple([workspace])
  if (name === 'git.diff')
    return tuple(
      [
        record({ path: text(4096), staged: { type: 'boolean' }, kind: { enum: ['staged', 'unstaged', 'untracked'] } }, [
          'path',
        ]),
        workspace,
      ],
      1,
    )
  if (name === 'git.review') return tuple([record(gitQuery, ['scope']), workspace], 1)
  if (name === 'git.reviewFile')
    return tuple([record({ query: record(gitQuery, ['scope']), path: text(4096) }, ['query', 'path']), workspace], 1)
  if (name === 'git.reviewOptions') return tuple([record({ search: text(256, 0), offset: integer() }), workspace], 1)
  if (name === 'activities.logs') return tuple([text(128), session], 1)
  if (name === 'events.read')
    return tuple([
      record({
        project,
        session,
        terminalId: text(128),
        limit: integer(100, 1),
        after: record({ journalEpoch: text(), seq: integer() }, ['journalEpoch', 'seq']),
      }),
    ])
  if (name === 'capabilities')
    return tuple([
      record({
        domain: text(128),
        scope: { enum: ['host', 'session', 'client'] },
        write: { type: 'boolean' },
        query: text(500),
        cursor: text(4096),
        offset: integer(),
        limit: integer(100, 1),
      }),
    ])
  if (name === 'capabilities.describe') return tuple([text(128)], 1)
  if (name === 'results.read') return tuple([record({ id: text(), ...piece }, ['id', 'revision'])], 1)
  if (name.startsWith('contextWindow.')) {
    const action = name.slice('contextWindow.'.length)
    if (['get', 'reply'].includes(action)) return tuple([text(), session], 1)
    if (action === 'list')
      return tuple([
        record({ cursor: text(4096), limit: integer(100, 1), includeAuxiliary: { type: 'boolean' } }),
        session,
      ])
    const properties: Record<string, unknown> = {
      requestId: text(),
      payloadRevision: integer(),
      kind: { enum: action === 'item' ? [...contextPartKinds] : [...contextPartKinds, 'reply'] },
      itemId: text(),
      ...(action === 'item'
        ? { offset: integer(), limit: integer(100, 1) }
        : { pieceIndex: integer(), ...(action === 'piece' ? { offset: integer(), limit: integer(20000, 1) } : {}) }),
    }
    return tuple([record(properties, ['requestId', 'kind', ...(action === 'item' ? [] : ['pieceIndex'])]), session], 1)
  }
  return undefined
}
