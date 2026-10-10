const { contextBridge } = require('electron')

const connection = { generation: 1, sessionKey: 'initial', sessionFile: 'initial', cwd: '/test', status: 'ready' }
const model = { id: 'test', provider: 'fake', name: 'test' }
let active = 'initial'
const pending = []
let selection = 0
const sequences = new Map()
let pendingHistory = null
let connectionListener = () => {}
let eventListener = () => {}
let sessionsListener = () => {}
const running = new Set()
const calls = []
const entries = [
  'initial',
  'a',
  'b',
  'c',
  'cancelled',
  'failed',
  'no-stats',
  'wide',
  'slow-history',
  'failed-after-select',
]
const tokens = { initial: 1000, a: 2000, b: 3000, c: 4000 }
const message = (name) => ({ role: 'user', content: `会话正文 ${name}`, timestamp: 1000 })
function history(name) {
  if (name === 'new') return []
  const messages = [message(name)]
  if (name === 'wide') {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `长路径：${'path_segment_'.repeat(100)}\n\n行内代码：\`${'inline_token_'.repeat(100)}\`\n\n\`\`\`bash\n${'long_command_argument '.repeat(100)}\n\`\`\``,
        },
      ],
      api: 'openai-completions',
      provider: 'fake',
      model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'stop',
      timestamp: 2000,
    })
  }
  return messages
}
function state(name) {
  return {
    model,
    sessionName: name,
    isStreaming: running.has(name),
    isCompacting: false,
    pendingMessageCount: 0,
    steeringMode: 'one-at-a-time',
    followUpMode: 'all',
  }
}
function stats() {
  return {
    tokens: { input: tokens[active] ?? 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens[active] ?? 0 },
    contextUsage: { tokens: tokens[active] ?? 0, contextWindow: 10000, percent: (tokens[active] ?? 0) / 100 },
  }
}
function snapshot() {
  return {
    connection: { ...connection },
    eventSequence: sequences.get(active) ?? 0,
    state: state(active),
    messages: history(active),
    models: [model],
    thinkingLevels: ['off'],
    stats: active === 'no-stats' ? undefined : stats(),
  }
}

contextBridge.exposeInMainWorld('piMemeTestBridge', {
  getConnection: async () => connection,
  getSnapshot: async () => snapshot(),
  getCommands: async () => [],
  getGitEnvironment: async () => ({ cwd: connection.cwd, root: '', dirty: false, branches: [] }),
  getSessions: async () => ({
    recents: entries.map((name) => ({
      id: name,
      path: name,
      name,
      cwd: '/test',
      messageCount: 1,
      running: running.has(name),
    })),
    projects: ['/test', '/other'].map((cwd) => ({ cwd, name: cwd.slice(1), sessions: [], sessionCount: 0 })),
    pinnedPaths: [],
    activeSessionId: active,
    activeSessionPath: active,
  }),
  onSessionsChanged: (listener) => {
    sessionsListener = listener
    return () => {
      sessionsListener = () => {}
    }
  },
  getSettings: async () => ({ settings: { themeId: 'dark' }, themes: [], errors: [] }),
  getSubagents: async () => ({ directory: '/test/subagents', agents: [], diagnostics: [] }),
  readSessionHistory: async (name) => {
    if (name === 'slow-history')
      await new Promise((resolve) => {
        pendingHistory = resolve
      })
    return { messages: name === 'slow-history' ? [message('本地过期预览')] : history(name), sessionName: name, model }
  },
  newSession: async () => {
    selection++
    if (active !== 'new') connection.generation++
    active = 'new'
    Object.assign(connection, { sessionKey: `new:${connection.cwd}`, sessionFile: undefined, status: 'idle' })
    connectionListener({ ...connection })
    return { cancelled: false, snapshot: snapshot() }
  },
  chooseDirectory: async (cwd) => {
    selection++
    if (active !== 'new' || cwd !== connection.cwd) connection.generation++
    active = 'new'
    Object.assign(connection, { cwd, sessionKey: `new:${cwd}`, sessionFile: undefined, status: 'idle' })
    connectionListener({ ...connection })
    return cwd
  },
  prefetchSession: async () => {},
  switchSession: async (name) => {
    calls.push(name)
    const id = ++selection
    return new Promise((resolve, reject) => {
      pending.push({ id, name, resolve, reject })
    })
  },
  onConnection: (listener) => {
    connectionListener = listener
    return () => {
      connectionListener = () => {}
    }
  },
  onEvent: (listener) => {
    eventListener = listener
    return () => {
      eventListener = () => {}
    }
  },
  onError: () => () => {},
})
contextBridge.exposeInMainWorld('sessionSwitchTest', {
  status: () => ({ active, calls, pending: pending.at(-1)?.name, connection: { ...connection } }),
  startAgent: () => {
    running.add(active)
    sequences.set(active, (sequences.get(active) ?? 0) + 1)
    eventListener({
      generation: connection.generation,
      sessionKey: connection.sessionKey,
      sequence: sequences.get(active),
      event: { type: 'agent_start' },
    })
    sessionsListener()
  },
  finishAgent: (name) => {
    running.delete(name)
    sequences.set(name, (sequences.get(name) ?? 0) + 1)
    eventListener({
      generation: connection.generation,
      sessionKey: name,
      sequence: sequences.get(name),
      event: { type: 'agent_settled' },
    })
    sessionsListener()
  },
  finishHistory: () => {
    pendingHistory?.()
    pendingHistory = null
  },
  finishConnection: () => {
    connection.status = 'ready'
    connectionListener({ ...connection })
  },
  finish: (name) => {
    const index = name === undefined ? pending.length - 1 : pending.findLastIndex((task) => task.name === name)
    const task = pending.splice(index, 1)[0]
    if (!task) throw new Error('没有待完成的会话选择')
    if (task.id !== selection || task.name === 'cancelled') task.resolve({ cancelled: true })
    else if (task.name === 'failed') task.reject(new Error('模拟切换失败'))
    else if (task.name === 'failed-after-select') {
      active = task.name
      Object.assign(connection, { generation: connection.generation + 1, sessionKey: active, sessionFile: active })
      connectionListener({ ...connection })
      task.reject(new Error('切换后的快照读取失败'))
    } else {
      active = task.name
      Object.assign(connection, {
        generation: connection.generation + 1,
        sessionKey: active,
        sessionFile: active,
        cwd: '/test',
        status: 'ready',
      })
      connectionListener({ ...connection })
      task.resolve({ cancelled: false, snapshot: snapshot() })
    }
  },
  finishStale: () => {
    for (const task of pending.splice(0)) task.resolve({ cancelled: true })
  },
})
