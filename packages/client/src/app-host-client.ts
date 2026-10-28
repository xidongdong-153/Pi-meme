import type { HostApi, EventSubscription, HostControlEvent } from '@pi-meme/contracts/app-host'

export type AppHostTransport = {
  call: <T>(method: string, args: unknown[], idempotencyKey?: string) => Promise<T>
  subscribe: (input: EventSubscription, listener: (event: HostControlEvent) => void) => Promise<() => void>
}
export function createAppHostClient(transport: AppHostTransport): HostApi {
  function call<T>(method: string, args: unknown[], idempotencyKey?: string): Promise<T> {
    // JSON 数组中的 undefined 会变成 null；省略末尾可选参数以保留服务端默认值。
    let length = args.length
    while (length && args[length - 1] === undefined) length--
    return transport.call<T>(method, args.slice(0, length), idempotencyKey)
  }
  return {
    apiVersion: 2,
    models: { list: () => call('models.list', []) },
    imageGeneration: {
      getConfig: () => call('imageGeneration.getConfig', []),
      saveModel: (input) => call('imageGeneration.saveModel', [input]),
      deleteModel: (id, revision) => call('imageGeneration.deleteModel', [id, revision]),
      setDefault: (id, revision) => call('imageGeneration.setDefault', [id, revision]),
      test: (id) => call('imageGeneration.test', [id]),
    },
    schedules: {
      list: () => call('schedules.list', []),
      get: (ref) => call('schedules.get', [ref]),
      create: (input, options) => call('schedules.create', [input], options.idempotencyKey),
      update: (ref, input, options) => call('schedules.update', [ref, input], options.idempotencyKey),
      pause: (ref, options) => call('schedules.pause', [ref], options.idempotencyKey),
      resume: (ref, options) => call('schedules.resume', [ref], options.idempotencyKey),
      delete: (ref, options) => call('schedules.delete', [ref], options.idempotencyKey),
      runNow: (ref, options) => call('schedules.runNow', [ref], options.idempotencyKey),
      stopRun: (ref, options) => call('schedules.stopRun', [ref], options.idempotencyKey),
      runs: (ref, input) => call('schedules.runs', [ref, input]),
      markRead: (ref, runId, options) => call('schedules.markRead', [ref, runId], options.idempotencyKey),
      resetSession: (ref, options) => call('schedules.resetSession', [ref], options.idempotencyKey),
    },
    capabilities: () => call('capabilities', []),
    plugins: {
      getDefaultAgentPlugins: () => call('plugins.getDefaultAgentPlugins', []),
      setDefaultAgentPlugins: (ids, options) => call('plugins.setDefaultAgentPlugins', [ids], options.idempotencyKey),
    },
    projects: {
      list: () => call('projects.list', []),
      get: (ref) => call('projects.get', [ref]),
      register: (input, options) => call('projects.register', [input], options.idempotencyKey),
    },
    sessions: {
      create: (input, options) => call('sessions.create', [input], options.idempotencyKey),
      list: (input) => call('sessions.list', [input]),
      get: (ref) => call('sessions.get', [ref]),
      snapshot: (ref) => call('sessions.snapshot', [ref]),
      history: (ref, input) => call('sessions.history', [ref, input]),
      messages: (ref, input) => call('sessions.messages', [ref, input]),
      message: (ref, input) => call('sessions.message', [ref, input]),
      configure: (ref, config, options) => call('sessions.configure', [ref, config], options.idempotencyKey),
      submit: (ref, input, options) => call('sessions.submit', [ref, input], options.idempotencyKey),
      stop: (ref, options) => call('sessions.stop', [ref], options.idempotencyKey),
      stopTask: (ref, options) => call('sessions.stopTask', [ref], options.idempotencyKey),
      continueTask: (ref, configuration, options) =>
        call('sessions.continueTask', [ref, configuration ?? null], options.idempotencyKey),
      pause: (ref, options) => call('sessions.pause', [ref], options.idempotencyKey),
      resume: (ref, options) => call('sessions.resume', [ref], options.idempotencyKey),
      receipt: (id) => call('sessions.receipt', [id]),
      submissions: (ref) => call('sessions.submissions', [ref]),
      cancelSubmission: (id, options) => call('sessions.cancelSubmission', [id], options.idempotencyKey),
    },
    events: {
      read: (input) => call('events.read', [input]),
      subscribe: transport.subscribe.bind(transport),
    },
    files: {
      list: (ref, relativePath) => call('files.list', [ref, relativePath]),
      read: (ref, relativePath) => call('files.read', [ref, relativePath]),
      preview: (ref, relativePath) => call('files.preview', [ref, relativePath]),
      search: (ref, input) => call('files.search', [ref, input]),
      write: (ref, input, options) => call('files.write', [ref, input], options.idempotencyKey),
    },
    terminal: {
      open: (ref, input, options) => call('terminal.open', [ref, input], options.idempotencyKey),
      attach: (ref) => call('terminal.attach', [ref]),
      input: (ref, data, options) => call('terminal.input', [ref, data], options.idempotencyKey),
      resize: (ref, size, options) => call('terminal.resize', [ref, size], options.idempotencyKey),
      close: (ref, options) => call('terminal.close', [ref], options.idempotencyKey),
    },
    git: {
      environment: (ref) => call('git.environment', [ref]),
      snapshot: (ref) => call('git.snapshot', [ref]),
      diff: (ref, input) => call('git.diff', [ref, input]),
    },
    interaction: {
      respond: (ref, input, options) => call('interaction.respond', [ref, input], options.idempotencyKey),
    },
    agents: {
      list: (ref) => call('agents.list', [ref]),
      get: (id) => call('agents.get', [id]),
      stop: (id, options) => call('agents.stop', [id], options.idempotencyKey),
    },
    activities: {
      list: (ref) => call('activities.list', [ref]),
      logs: (ref, id) => call('activities.logs', [ref, id]),
      stop: (ref, id, options) => call('activities.stop', [ref, id], options.idempotencyKey),
    },
    goals: {
      get: (ref) => call('goals.get', [ref]),
      start: (ref, input, options) => call('goals.start', [ref, input], options.idempotencyKey),
      edit: (ref, input, options) => call('goals.edit', [ref, input], options.idempotencyKey),
      pause: (ref, input, options) => call('goals.pause', [ref, input], options.idempotencyKey),
      resume: (ref, input, options) => call('goals.resume', [ref, input], options.idempotencyKey),
      clear: (ref, input, options) => call('goals.clear', [ref, input], options.idempotencyKey),
    },
    plans: { list: (ref) => call('plans.list', [ref]) },
  }
}
