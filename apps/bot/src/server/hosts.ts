import { createHash, randomUUID } from 'node:crypto'
import { queueQqDeliveries } from './qq-outbox.js'
import WebSocket from 'ws'
import { createNodeHostClient, type NodeHostClient } from '@pi-meme/client/node-host-client'
import type { InteractionAnswer, SubmissionReceipt } from '@pi-meme/contracts/app-host'
import type { BotApp, BotServices, HostAdapter } from './contracts.js'
import type { HostConnection, Task } from '../shared/types.js'
import { BotError, requireItem } from './errors.js'
import { collaborationAllowed, hostAllowed } from './task-interactions.js'

const active = new Set(['queued', 'running', 'waiting', 'stopping'])
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BotError(400, 'invalid-input', `${label}不能为空且最多${max}字符`)
  return value.trim()
}
function address(value: unknown): string {
  let url: URL
  try {
    url = new URL(text(value, 'Host 地址', 2048))
  } catch {
    throw new BotError(400, 'invalid-input', 'Host 地址不是有效的 HTTP(S) URL')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new BotError(400, 'invalid-input', '远程 Host 使用 HTTPS，本机回环可使用 HTTP；地址不可含账号、查询或片段')
  if (url.pathname !== '/') throw new BotError(400, 'invalid-input', 'Host 地址必须是服务根地址')
  return url.origin
}
function publicHost(host: HostConnection) {
  const { credentialRef, ...value } = host
  return { ...value, hasCredential: !!credentialRef }
}
function touch<T extends { revision: number; updatedAt: string }>(value: T): T {
  value.revision++
  value.updatedAt = new Date().toISOString()
  return value
}
function revision(input: unknown, actual: number) {
  if (!Number.isInteger(input) || !Number.isInteger(actual) || input !== actual)
    throw new BotError(409, 'revision-conflict', '配置已修改，请重新读取', { revision: actual })
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((v) => typeof v !== 'string' || !v || v.length > 200))
    throw new BotError(400, 'invalid-input', 'projectIds 必须是项目 ID 数组')
  return [...new Set(value)]
}
function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timer)
      reject(new BotError(409, 'outcome-unknown', '本地等待已取消，远端任务状态仍需核对'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, 1500)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

async function readInput(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => {
    throw new BotError(400, 'invalid-input', '请求体必须为 JSON 对象')
  })
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BotError(400, 'invalid-input', '请求体必须为 JSON 对象')
  return value as Record<string, unknown>
}

export function registerHostRoutes(app: BotApp, services: BotServices): HostAdapter {
  const { store } = services
  const clients = new Map<string, { revision: number; value: NodeHostClient }>()
  let closed = false
  const hostFor = (id: string) => {
    return requireItem(store.read().hosts[id], 'Host')
  }
  const taskFor = (id: string) => {
    return requireItem(store.read().tasks[id], '任务')
  }
  const invalidate = (id: string) => {
    clients.get(id)?.value.dispose()
    clients.delete(id)
  }
  async function clientFor(id: string, checkConnection = false): Promise<NodeHostClient> {
    if (closed) throw new BotError(503, 'upstream-unavailable', 'Host 适配器已关闭')
    const host = hostFor(id)
    if (host.status === 'identity-changed')
      throw new BotError(409, 'host-identity-changed', 'Host 身份发生变化，请移除后重新登记并授权')
    const cached = clients.get(id)
    if (cached?.revision === host.revision && host.status === 'online' && !checkConnection) return cached.value
    if (cached?.revision !== host.revision) invalidate(id)
    const token = await store.secret(host.credentialRef)
    if (!token) throw new BotError(409, 'capability-unavailable', '尚未配置 Host 凭据')
    let identity: string | undefined
    let expectedHostId = host.expectedHostId
    try {
      const client =
        cached?.revision === host.revision
          ? cached.value
          : await createNodeHostClient({
              url: host.url,
              token,
              hostId: host.expectedHostId,
              clientId: `bots-${store.read().epoch}-${id}`.slice(0, 128),
              webSocket: (url, headers) => new WebSocket(url, { headers }),
              fetch: (url, init) => {
                const current = hostFor(id)
                if (
                  current.url !== host.url ||
                  current.credentialRef !== host.credentialRef ||
                  (expectedHostId && current.expectedHostId !== expectedHostId) ||
                  current.status === 'identity-changed'
                )
                  throw new BotError(403, 'forbidden', 'Host 连接配置已改变，请重新检查连接')
                return fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30000) })
              },
            })
      const capabilities = await client.capabilities()
      identity = capabilities.hostId
      const next = await store.update((draft) => {
        const current = draft.hosts[id]
        if (!current || current.url !== host.url || current.credentialRef !== host.credentialRef)
          throw new BotError(409, 'revision-conflict', '连接配置已变化')
        if (current.expectedHostId && current.expectedHostId !== identity)
          throw new BotError(409, 'host-identity-changed', 'Host 身份发生变化')
        current.expectedHostId = identity
        current.status = 'online'
        current.error = undefined
        current.checkedAt = new Date().toISOString()
        current.capabilities = capabilities.features
        // 连接观测单独更新 checkedAt，配置与授权编辑才推进 revision。
        current.updatedAt = current.checkedAt
        return current
      })
      expectedHostId = identity
      clients.set(id, { revision: next.revision, value: client })
      return client
    } catch (error) {
      const changed = error instanceof Error && error.message.includes('身份')
      await store.update((draft) => {
        const current = draft.hosts[id]
        if (current && current.url === host.url && current.credentialRef === host.credentialRef) {
          current.status = changed ? 'identity-changed' : 'offline'
          current.error = changed ? 'Host 身份发生变化，已阻断' : '连接或认证失败，请核对地址、凭据和网络'
          current.checkedAt = new Date().toISOString()
          current.updatedAt = current.checkedAt
        }
      })
      throw new BotError(
        502,
        changed ? 'host-identity-changed' : 'upstream-unavailable',
        changed ? 'Host 身份发生变化，已阻断连接' : 'Host 连接或认证失败',
      )
    }
  }
  function authorize(taskId: string, hostId: string, projectId: string, allowFinished = false) {
    const state = store.read()
    const task = state.tasks[taskId]
    const bot = task && state.bots[task.botId]
    const host = hostFor(hostId)
    const conversation = task && state.conversations[task.conversationId]
    if (!conversation || conversation.archived) throw new BotError(403, 'forbidden', '来源会话已归档或不存在')
    let memberTask = task
    const visited = new Set<string>()
    while (memberTask && !memberTask.publicReply && memberTask.parentTaskId) {
      if (visited.has(memberTask.id)) throw new BotError(403, 'forbidden', '协作任务链无效')
      visited.add(memberTask.id)
      const parent = state.tasks[memberTask.parentTaskId]
      const parentBot = parent && state.bots[parent.botId]
      if (
        !parent ||
        parent.stopRequested ||
        (!allowFinished && !active.has(parent.status)) ||
        !parentBot?.enabled ||
        (parent.botId !== memberTask.botId && !collaborationAllowed(state, parent, memberTask.botId))
      )
        throw new BotError(403, 'forbidden', '后台协作授权已失效')
      memberTask = parent
    }
    if (!memberTask || !conversation.memberIds.includes(memberTask.botId))
      throw new BotError(403, 'forbidden', '来源角色已被移除')
    if (!task || !bot?.enabled || task.stopRequested || (!allowFinished && !active.has(task.status)))
      throw new BotError(403, 'forbidden', '任务或角色已停用')
    if (!hostAllowed(state, task, hostId, projectId) || !host.projectIds.includes(projectId))
      throw new BotError(403, 'forbidden', '当前 Bot 未获该 Host 或项目授权')
    return { task, host }
  }
  const adapter: HostAdapter = {
    async delegate(input, signal) {
      const prompt = text(input.prompt, '任务内容', 100000)
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([input.hostId, input.projectId, prompt]))
        .digest('hex')
      authorize(input.taskId, input.hostId, input.projectId)
      await store.update((draft) => {
        const key = `host-input:${input.taskId}`
        if (draft.inboundIds[key] && draft.inboundIds[key] !== fingerprint)
          throw new BotError(409, 'idempotency-conflict', '同一 Host 委派任务不能更改输入，请建立新委派')
        draft.inboundIds[key] = fingerprint
        draft.inboundIds[`host-prompt:${input.taskId}`] = prompt
      })
      const client = await clientFor(input.hostId)
      const host = hostFor(input.hostId)
      const checkCurrent = () => {
        try {
          if (signal?.aborted) throw new BotError(403, 'forbidden', '委派等待已取消')
          const current = authorize(input.taskId, input.hostId, input.projectId).host
          if (
            current.url !== host.url ||
            current.credentialRef !== host.credentialRef ||
            current.expectedHostId !== host.expectedHostId
          )
            throw new BotError(403, 'forbidden', 'Host 连接配置已改变')
        } catch (cause) {
          if (taskFor(input.taskId).hostDelegation?.operationId)
            throw new BotError(409, 'outcome-unknown', '后续 Host 调用已停止，远端已有操作请通过回执核对')
          throw cause
        }
      }
      const project = { hostId: host.expectedHostId!, projectId: input.projectId }
      checkCurrent()
      await client.projects.get(project)
      let delegation = taskFor(input.taskId).hostDelegation
      if (input.sessionId && delegation?.sessionId && input.sessionId !== delegation.sessionId)
        throw new BotError(409, 'idempotency-conflict', '同一委派不能更改远端会话')
      if (delegation && (delegation.hostId !== input.hostId || delegation.projectId !== input.projectId))
        throw new BotError(409, 'conflict', '该任务已关联另一项 Host 委派，请创建新任务')
      if (delegation && !delegation.operationId && delegation.status !== 'prepared')
        throw new BotError(409, 'outcome-unknown', '上次 Host 操作结果未确认，禁止自动重放')
      if (!delegation) {
        delegation = {
          hostId: input.hostId,
          projectId: input.projectId,
          idempotencyKey: `bot-${input.taskId}`,
          status: 'prepared',
        }
        await store.update((draft) => {
          const task = draft.tasks[input.taskId]
          if (task.hostDelegation) throw new BotError(409, 'conflict', '任务已有在途委派')
          task.hostDelegation = delegation
          touch(task)
        })
      }
      if (!delegation.operationId) {
        if (signal?.aborted) throw new BotError(409, 'outcome-unknown', '委派等待已取消')
        authorize(input.taskId, input.hostId, input.projectId)
        await store.update((draft) => {
          draft.tasks[input.taskId].hostDelegation!.status = 'creating'
          touch(draft.tasks[input.taskId])
        })
        try {
          let session
          if (signal?.aborted) throw new BotError(409, 'outcome-unknown', '委派等待已取消')
          authorize(input.taskId, input.hostId, input.projectId)
          if (input.sessionId) {
            checkCurrent()
            session = await client.sessions.get({ hostId: project.hostId, sessionId: input.sessionId })
            if (session.project?.projectId !== input.projectId || session.configuration.accessMode === 'full-access')
              throw new BotError(403, 'forbidden', '目标会话不属于授权项目或权限高于工作区修改')
          } else {
            checkCurrent()
            session = await client.sessions.create(
              {
                project,
                configuration: { accessMode: 'workspace-write', mode: 'default' },
                name: `Bots · ${taskFor(input.taskId).config.name}`,
              },
              { idempotencyKey: `${delegation.idempotencyKey}-session` },
            )
          }
          checkCurrent()
          const baseline = await client.sessions.messages(session, { limit: 1 })
          checkCurrent()
          const boundary = baseline.totalMessages
            ? await client.sessions.messages(session, { offset: baseline.totalMessages - 1, limit: 1 })
            : baseline
          await store.update((draft) => {
            draft.inboundIds[`host-boundary:${input.taskId}`] = JSON.stringify({
              count: baseline.totalMessages,
              entryId: boundary.messages[0]?.id,
              branchRevision: baseline.branchRevision,
            })
            draft.tasks[input.taskId].hostDelegation!.sessionId = session.sessionId
            draft.tasks[input.taskId].hostDelegation!.status = 'submitting'
            touch(draft.tasks[input.taskId])
          })
          checkCurrent()
          const receipt = await client.sessions.submit(
            session,
            { delivery: 'start', text: text(input.prompt, '任务内容', 100000) },
            { idempotencyKey: `${delegation.idempotencyKey}-submit` },
          )
          await saveReceipt(input.taskId, receipt)
        } catch (error) {
          await store.update((draft) => {
            const d = draft.tasks[input.taskId]?.hostDelegation
            if (d) {
              d.status = 'unknown'
              touch(draft.tasks[input.taskId])
            }
          })
          throw error
        }
      }
      const deadline = Date.now() + 30 * 60_000
      while (Date.now() < deadline) {
        if (closed) break
        checkCurrent()
        const current = taskFor(input.taskId).hostDelegation!
        if (!current.operationId || !current.sessionId)
          throw new BotError(409, 'outcome-unknown', 'Host 尚未返回稳定回执')
        const receipt = await client.sessions.receipt(current.operationId)
        checkCurrent()
        await saveReceipt(input.taskId, receipt)
        if (receipt.status === 'completed') {
          const baseline = JSON.parse(store.read().inboundIds[`host-boundary:${input.taskId}`] ?? 'null') as {
            count: number
            entryId?: string
          } | null
          if (!baseline) throw new BotError(409, 'outcome-unknown', '缺少提交前消息边界，不能将旧会话结果作为本次交付')
          if (baseline.count) {
            checkCurrent()
            const boundary = await client.sessions.messages(receipt.session, { offset: baseline.count - 1, limit: 1 })
            if (boundary.messages[0]?.id !== baseline.entryId)
              throw new BotError(409, 'outcome-unknown', 'Host 消息分支已变化，请在正式会话核对结果')
          }
          const messages = []
          let offset = baseline.count
          while (true) {
            checkCurrent()
            const page = await client.sessions.messages(receipt.session, { offset, limit: 200 })
            messages.push(...page.messages)
            if (page.nextOffset === undefined) break
            offset = page.nextOffset
            if (messages.length > 2000)
              throw new BotError(409, 'outcome-unknown', '本次结果过长，请在 Host 正式会话查看')
          }
          const inputs = messages.filter((message) => message.role === 'user')
          if (inputs.length !== 1 || inputs[0].text.trim() !== prompt)
            throw new BotError(
              409,
              'outcome-unknown',
              '提交边界后存在其他输入或正文不匹配，无法确定本次结果；请在 Host 核对',
            )
          const answer = messages
            .filter((message) => message.role === 'assistant' && message.state === 'complete')
            .map((message) => message.text)
            .join('\n\n')
          const result = answer || 'Host 已完成任务；正式会话中没有可读取的文本结果。'
          checkCurrent()
          await store.update((draft) => {
            draft.tasks[input.taskId].hostDelegation!.result = result
            touch(draft.tasks[input.taskId])
          })
          return result
        }
        if (['failed', 'interrupted', 'cancelled'].includes(receipt.status))
          throw new BotError(
            409,
            receipt.outcomeUncertain ? 'outcome-unknown' : 'upstream-failed',
            receipt.error || `Host 任务${receipt.status}`,
          )
        if (current.cursor) {
          checkCurrent()
          await client.events.read({ sessionId: receipt.session.sessionId, after: current.cursor })
        }
        checkCurrent()
        const snapshot = await client.sessions.snapshot(receipt.session)
        checkCurrent()
        await store.update((draft) => {
          draft.tasks[input.taskId].hostDelegation!.cursor = snapshot.controlCursor
        })
        if (snapshot.pendingInteractions?.length)
          await store.update((draft) => {
            const task = draft.tasks[input.taskId]
            if (!task.stopRequested) task.status = 'waiting'
            touch(task)
          })
        await pause(signal)
      }
      throw new BotError(504, 'outcome-unknown', 'Host 任务仍未确认完成，请通过回执核对，不会自动重新提交')
    },
    async stop(task) {
      const d = task.hostDelegation
      if (!d?.sessionId) return false
      try {
        const client = await clientFor(d.hostId)
        const host = hostFor(d.hostId)
        await client.sessions.stop(
          { hostId: host.expectedHostId!, sessionId: d.sessionId },
          { idempotencyKey: `${d.idempotencyKey}-stop` },
        )
        if (!d.operationId) return false
        const receipt = await client.sessions.receipt(d.operationId)
        await saveReceipt(task.id, receipt)
        return ['cancelled', 'completed', 'failed', 'interrupted'].includes(receipt.status) && !receipt.outcomeUncertain
      } catch {
        return false
      }
    },
    async close() {
      closed = true
      for (const id of clients.keys()) invalidate(id)
    },
  }
  async function saveReceipt(taskId: string, receipt: SubmissionReceipt) {
    const current = store.read().tasks[taskId]?.hostDelegation
    if (
      current?.operationId === receipt.operationId &&
      current.submissionId === receipt.submissionId &&
      current.sessionId === receipt.session.sessionId &&
      current.status === receipt.status &&
      current.runId === receipt.runId
    )
      return
    await store.update((draft) => {
      const task = draft.tasks[taskId]
      if (!task?.hostDelegation) return
      Object.assign(task.hostDelegation, {
        operationId: receipt.operationId,
        submissionId: receipt.submissionId,
        sessionId: receipt.session.sessionId,
        runId: receipt.runId,
        status: receipt.status,
        lastSyncedAt: new Date().toISOString(),
      })
      touch(task)
    })
  }
  app.get('/api/v1/hosts', (c) => c.json(Object.values(store.read().hosts).map(publicHost)))
  app.get('/api/v1/hosts/:id', (c) => c.json(publicHost(hostFor(c.req.param('id')))))
  app.post('/api/v1/hosts', async (c) => {
    const input = await readInput(c.req)
    const name = text(input.name, '连接名称', 80)
    const url = address(input.url)
    const projectIds = ids(input.projectIds ?? [])
    const credentialRef = input.token ? await store.writeSecret(text(input.token, '凭据', 8192)) : undefined
    const now = new Date().toISOString()
    const host: HostConnection = {
      id: randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      name,
      url,
      credentialRef,
      projectIds,
      status: 'unchecked',
    }
    await store.update((draft) => {
      draft.hosts[host.id] = host
    })
    return c.json(publicHost(host), 201)
  })
  app.patch('/api/v1/hosts/:id', async (c) => {
    const id = c.req.param('id')
    const input = await readInput(c.req)
    const old = hostFor(id)
    revision(input.revision, old.revision)
    const name = input.name === undefined ? old.name : text(input.name, '连接名称', 80)
    const url = input.url === undefined ? old.url : address(input.url)
    const projectIds = input.projectIds === undefined ? old.projectIds : ids(input.projectIds)
    if (
      url !== old.url &&
      Object.values(store.read().tasks).some((t) => t.hostDelegation?.hostId === id && active.has(t.status))
    )
      throw new BotError(409, 'conflict', '仍有活动委派，不能更改地址')
    const credentialRef = input.token ? await store.writeSecret(text(input.token, '凭据', 8192)) : old.credentialRef
    const host = await store.update((draft) => {
      const host = draft.hosts[id]
      revision(input.revision, host.revision)
      Object.assign(host, { name, url, projectIds, credentialRef, status: 'unchecked', error: undefined })
      return touch(host)
    })
    invalidate(id)
    if (old.credentialRef !== credentialRef) await store.deleteSecret(old.credentialRef)
    return c.json(publicHost(host))
  })
  app.delete('/api/v1/hosts/:id', async (c) => {
    const id = c.req.param('id')
    const host = hostFor(id)
    const input = await readInput(c.req).catch((): Record<string, unknown> => ({}))
    revision(input.revision, host.revision)
    if (Object.values(store.read().tasks).some((t) => t.hostDelegation?.hostId === id && active.has(t.status)))
      throw new BotError(409, 'conflict', '该 Host 仍有活动任务，请先处理任务')
    await store.update((draft) => {
      revision(input.revision, draft.hosts[id].revision)
      delete draft.hosts[id]
    })
    invalidate(id)
    await store.deleteSecret(host.credentialRef)
    return c.json({ removed: true })
  })
  app.post('/api/v1/hosts/:id/check', async (c) => {
    const id = c.req.param('id')
    await clientFor(id, true)
    return c.json(publicHost(hostFor(id)))
  })
  app.get('/api/v1/hosts/:id/projects', async (c) => {
    const id = c.req.param('id')
    const client = await clientFor(id)
    return c.json(await client.projects.list())
  })
  app.post('/api/v1/hosts/:id/projects', async (c) => {
    const id = c.req.param('id')
    const input = await readInput(c.req)
    const client = await clientFor(id)
    return c.json(
      await client.projects.create(
        {
          cwd: text(input.cwd, 'Host 上已有目录', 4096),
          name: input.name === undefined ? undefined : text(input.name, '项目名称', 80),
        },
        { idempotencyKey: `bots-project-${c.req.header('Idempotency-Key')}` },
      ),
      201,
    )
  })
  app.post('/api/v1/delegations', async (c) => {
    const input = await readInput(c.req)
    const prompt = text(input.prompt, '任务内容', 100000)
    const state = store.read()
    const hostId = text(input.hostId, 'Host ID', 128)
    const projectId = text(input.projectId, '项目 ID', 128)
    const sessionId = input.sessionId === undefined ? undefined : text(input.sessionId, '会话 ID', 128)
    const bot = state.bots[text(input.botId, 'Bot ID', 128)]
    const conversation = state.conversations[text(input.conversationId, '来源会话 ID', 128)]
    if (!bot?.enabled || !conversation || !conversation.memberIds.includes(bot.id))
      throw new BotError(403, 'forbidden', '角色不属于该会话')
    const now = new Date().toISOString()
    const taskId = randomUUID()
    const messageId = randomUUID()
    const task: Task = {
      id: taskId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      conversationId: conversation.id,
      sourceMessageId: messageId,
      botId: bot.id,
      status: 'running',
      prompt,
      config: bot,
      attachmentIds: [],
      toolCalls: 0,
      publicReply: true,
      depth: 0,
      hostDelegation: {
        hostId,
        projectId,
        idempotencyKey: `bot-${taskId}`,
        status: 'prepared',
      },
    }
    const host = hostFor(hostId)
    if (!hostAllowed(state, task, host.id, projectId) || !host.projectIds.includes(projectId))
      throw new BotError(403, 'forbidden', '角色未获目标 Host/项目授权')
    await store.update((draft) => {
      const conv = requireItem(draft.conversations[conversation.id], '来源会话')
      const currentBot = requireItem(draft.bots[bot.id], 'Bot')
      const currentHost = requireItem(draft.hosts[hostId], 'Host')
      if (
        conv.archived ||
        !conv.memberIds.includes(bot.id) ||
        !currentBot.enabled ||
        !hostAllowed(draft, task, hostId, projectId) ||
        !currentHost.projectIds.includes(projectId)
      )
        throw new BotError(403, 'forbidden', '角色或 Host 项目授权已撤销')
      draft.messages[messageId] = {
        id: messageId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        conversationId: conv.id,
        sequence: ++conv.sequence,
        role: 'user',
        content: prompt,
        authorName: '我',
        attachmentIds: [],
        source: 'api',
        recipientIds: [bot.id],
      }
      touch(conv)
      draft.tasks[taskId] = task
    })
    void adapter
      .delegate({ taskId, hostId, projectId, prompt, sessionId })
      .then((result) => finish(taskId, result))
      .catch((error) => finish(taskId, undefined, error))
    return c.json({ taskId, status: 'accepted' }, 202)
  })
  async function finish(taskId: string, result?: string, error?: unknown) {
    await store.update((draft) => {
      const task = draft.tasks[taskId]
      if (!task || task.stopRequested || task.status === 'completed') return
      task.status = error
        ? error instanceof BotError && !['outcome-unknown', 'upstream-unavailable'].includes(error.code)
          ? 'failed'
          : 'unknown'
        : 'completed'
      task.result = result
      task.error = error ? 'Host 执行未确认，请查看委派回执后处理' : undefined
      task.finishedAt = new Date().toISOString()
      touch(task)
      if (!result) return
      const conv = draft.conversations[task.conversationId]
      const id = randomUUID()
      const now = new Date().toISOString()
      draft.messages[id] = {
        id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        conversationId: conv.id,
        sequence: ++conv.sequence,
        role: 'assistant',
        content: result,
        botId: task.botId,
        authorName: task.config.name,
        taskId,
        attachmentIds: [],
        source: draft.messages[task.sourceMessageId]?.source ?? 'api',
        sourceMessageId: task.sourceMessageId,
      }
      queueQqDeliveries(draft, draft.messages[id])
      touch(conv)
    })
  }
  app.get('/api/v1/delegations/:id', async (c) => {
    const task = taskFor(c.req.param('id'))
    const d = task.hostDelegation
    if (!d) throw new BotError(404, 'not-found', '任务没有 Host 委派')
    const client = await clientFor(d.hostId)
    const host = hostFor(d.hostId)
    const receipt = d.operationId ? await client.sessions.receipt(d.operationId) : undefined
    if (receipt) await saveReceipt(task.id, receipt)
    const snapshot = d.sessionId
      ? await client.sessions.snapshot({ hostId: host.expectedHostId!, sessionId: d.sessionId })
      : undefined
    return c.json({ task: taskFor(task.id), receipt, snapshot })
  })
  app.post('/api/v1/delegations/:id/reconcile', async (c) => {
    const task = taskFor(c.req.param('id'))
    const d = task.hostDelegation
    if (!d?.operationId)
      throw new BotError(409, 'outcome-unknown', '缺少远端稳定回执，不能自动重新创建或提交任务；请到 Host 核对')
    if (task.status === 'completed') return c.json({ taskId: task.id, status: task.status })
    if (active.has(task.status)) throw new BotError(409, 'conflict', '该任务仍在等待远端，请查看实时状态')
    if (task.stopRequested) throw new BotError(409, 'conflict', '该任务已请求停止，请查看远端实际回执')
    await store.update((draft) => {
      draft.tasks[task.id].status = 'running'
      touch(draft.tasks[task.id])
    })
    void adapter
      .delegate({
        taskId: task.id,
        hostId: d.hostId,
        projectId: d.projectId,
        prompt: store.read().inboundIds[`host-prompt:${task.id}`] ?? task.prompt,
        sessionId: d.sessionId,
      })
      .then((result) => finish(task.id, result))
      .catch((error) => finish(task.id, undefined, error))
    return c.json({ taskId: task.id, status: 'accepted' }, 202)
  })
  app.post('/api/v1/delegations/:id/attachments', async (c) => {
    const task = taskFor(c.req.param('id'))
    const delegation = task.hostDelegation
    if (!delegation?.sessionId) throw new BotError(404, 'not-found', '缺少 Host 委派会话')
    const { host } = authorize(task.id, delegation.hostId, delegation.projectId, true)
    const input = await readInput(c.req)
    const relativePath = text(input.path, 'Host 产物路径', 4096)
    const client = await clientFor(host.id)
    authorize(task.id, delegation.hostId, delegation.projectId, true)
    const preview = await client.files.preview(
      { hostId: hostFor(host.id).expectedHostId!, sessionId: delegation.sessionId },
      relativePath,
    )
    authorize(task.id, delegation.hostId, delegation.projectId, true)
    if (preview.kind === 'unsupported')
      throw new BotError(409, 'capability-unavailable', `Host 无法读取该产物：${preview.reason}`)
    let bytes: Uint8Array
    let mime: string
    if (preview.kind === 'image') {
      const match = preview.dataUrl.match(/^data:([^;]+);base64,([a-zA-Z0-9+/=]+)$/)
      if (!match) throw new BotError(502, 'upstream-unavailable', 'Host 图片数据无效')
      mime = match[1]
      bytes = Buffer.from(match[2], 'base64')
    } else {
      mime = 'text/plain'
      bytes = Buffer.from(preview.content, 'utf8')
    }
    const attachment = await services.saveAttachment({
      name: relativePath.split(/[\\/]/).pop() || 'Host 产物',
      mime,
      bytes,
      taskId: task.id,
      conversationId: task.conversationId,
      source: 'host',
    })
    await store.update((draft) => {
      draft.tasks[task.id].attachmentIds.push(attachment.id)
      touch(draft.tasks[task.id])
    })
    return c.json(attachment, 201)
  })
  app.post('/api/v1/delegations/:id/interaction', async (c) => {
    const task = taskFor(c.req.param('id'))
    const d = task.hostDelegation
    if (!d?.sessionId) throw new BotError(404, 'not-found', '缺少委派会话')
    authorize(task.id, d.hostId, d.projectId)
    const input = await readInput(c.req)
    const requestId = text(input.requestId, '交互请求', 200)
    const response = input.response as InteractionAnswer
    if (!response || typeof response !== 'object') throw new BotError(400, 'invalid-input', '交互答案无效')
    const client = await clientFor(d.hostId)
    authorize(task.id, d.hostId, d.projectId)
    await client.interaction.respond(
      { hostId: hostFor(d.hostId).expectedHostId!, sessionId: d.sessionId },
      { requestId, response, agentId: input.agentId === undefined ? undefined : text(input.agentId, 'Agent ID', 128) },
      { idempotencyKey: `bots-interact-${c.req.header('Idempotency-Key')}` },
    )
    return c.json({ accepted: true })
  })
  return adapter
}
