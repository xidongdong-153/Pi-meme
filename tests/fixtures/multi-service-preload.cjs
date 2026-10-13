const { contextBridge } = require('electron')

const controls = {}
function createService(id) {
  let connection = {
    generation: 1,
    sessionKey: 'same-id',
    sessionFile: 'same-path',
    cwd: '/same',
    workspaceKind: 'project',
    status: 'idle',
  }
  let mode = 'default'
  let count = 0
  const switchedPaths = []
  let sidebar = {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
  let delayCommands = false
  let pendingCommands
  const listeners = { connection: new Set(), events: new Set(), sessions: new Set() }
  const model = { id: 'fake', provider: 'fake', name: `${id}模型` }
  const state = () => ({
    mode,
    model,
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'all',
    pendingMessageCount: 0,
  })
  const snapshot = () => ({
    connection: { ...connection },
    state: state(),
    messages: [],
    models: [model],
    thinkingLevels: ['off'],
  })
  const subscribe = (kind, listener) => {
    listeners[kind].add(listener)
    return () => listeners[kind].delete(listener)
  }
  const select = async (input) => {
    count++
    mode = 'default'
    connection = {
      ...connection,
      generation: connection.generation + 1,
      cwd: input.kind === 'standalone' ? '/standalone' : input.cwd,
      workspaceKind: input.kind,
      sessionKey: `new-${count}`,
      sessionFile: undefined,
    }
    for (const listener of listeners.connection) listener({ ...connection })
    return { cancelled: false, snapshot: snapshot(), commands: [] }
  }
  const bridge = {
    getConnection: async () => ({ ...connection }),
    resolveAppSession: async (key) => ({
      hostId: id,
      sessionId: key,
      project: connection.workspaceKind === 'project' ? { hostId: id, projectId: connection.cwd } : undefined,
      cwd: connection.cwd,
      createdAt: '',
      configuration: { agentPlugins: [] },
      status: 'idle',
    }),
    getSnapshot: async () => snapshot(),
    getCommands: async () => {
      if (delayCommands)
        await new Promise((resolve) => {
          pendingCommands = resolve
        })
      return [
        {
          name: 'plan',
          description: '计划模式',
          source: 'builtin',
          sourceInfo: { path: 'builtin:plan', source: 'builtin', scope: 'host', origin: 'top-level' },
        },
      ]
    },
    getProjects: async () => [{ cwd: '/same', name: '同名项目', lastSelectedAt: '' }],
    getSessions: async () => ({
      recents: [],
      projects: [
        {
          cwd: '/same',
          name: '同名项目',
          sessionCount: 1,
          lastModified: '',
          sessions: [
            {
              id: 'same-id',
              path: 'same-path',
              name: `${id}旧对话`,
              cwd: '/same',
              workspaceKind: 'project',
              messageCount: 1,
              modified: '',
              created: '',
            },
          ],
        },
      ],
      pinnedPaths: [],
      activeSessionId: connection.sessionKey,
      activeSessionPath: connection.sessionFile,
    }),
    getSettings: async () => ({
      settings: { themeId: 'dark', sidebar },
      themes: [],
      themesDirectory: '/fixture/themes',
      errors: [],
    }),
    saveSidebarPreferences: async (patch) => {
      sidebar = {
        ...sidebar,
        ...patch,
        collapsed: { ...sidebar.collapsed, ...patch.collapsed },
        orders: { ...sidebar.orders, ...patch.orders },
      }
      return sidebar
    },
    getModelConfig: async () => ({ path: '/fixture/models.json', revision: 'fixture-models', providers: [] }),
    getDefaultModel: async () => model,
    getGitEnvironment: async () => ({ cwd: '/same', root: '', dirty: false, branches: [] }),
    getGitSnapshot: async () => ({ cwd: connection.cwd, files: [], insertions: 0, deletions: 0 }),
    selectWorkspace: select,
    newSession: async () =>
      connection.sessionFile
        ? select({ kind: connection.workspaceKind, cwd: connection.cwd })
        : { cancelled: false, snapshot: snapshot(), commands: [] },
    switchSession: async (path) => {
      switchedPaths.push(path)
      connection = {
        ...connection,
        generation: connection.generation + 1,
        sessionKey: 'same-id',
        sessionFile: path,
        cwd: '/same',
        workspaceKind: 'project',
      }
      mode = 'default'
      for (const listener of listeners.connection) listener({ ...connection })
      return { cancelled: false, snapshot: snapshot() }
    },
    setSessionMode: async (_key, next) => {
      mode = next
    },
    prefetchSession: async () => {},
    readSessionHistory: async () => ({ cwd: '/same', created: '', messages: [] }),
    onConnection: (listener) => subscribe('connection', listener),
    onEvent: (listener) => subscribe('events', listener),
    onSessionsChanged: (listener) => subscribe('sessions', listener),
    onError: () => () => {},
  }
  controls[id] = {
    status: () => ({
      count,
      mode,
      pendingCommands: Boolean(pendingCommands),
      connection: { ...connection },
      switchedPaths: [...switchedPaths],
    }),
    delayCommands: () => {
      delayCommands = true
    },
    releaseCommands: () => {
      delayCommands = false
      pendingCommands?.()
      pendingCommands = undefined
    },
    emit: (text) => {
      for (const listener of listeners.events)
        listener({
          generation: connection.generation,
          sessionKey: connection.sessionKey,
          event: { type: 'message_end', message: { role: 'user', content: text, timestamp: 111 } },
        })
    },
  }
  return bridge
}
contextBridge.exposeInMainWorld('piMemeMultiServiceBridges', {
  local: createService('local'),
  remote: createService('remote'),
})
contextBridge.exposeInMainWorld('multiServiceTest', controls)
