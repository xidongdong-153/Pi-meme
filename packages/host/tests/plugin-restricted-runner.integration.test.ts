import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { RestrictedRunner } from '@pi-meme/plugin-runtime/restricted-runner'
import { pluginSandboxLaunch } from '../src/plugin-sandbox'
import { probePluginSandbox } from '../src/plugin-sandbox-probe'
import { createHost } from '../src/service'
import { allowedRestrictedContribution } from '../src/plugin-call-bridge'
import { emptyPluginGrant } from '@pi-meme/plugin-sdk/permissions'
import type { DesktopEvent } from '@pi-meme/contracts/desktop'
import { bundleFacets } from '@earendil-works/chord/bundler'
import { useFakeAgent } from '../../../tests/fixtures/fake-agent.mjs'
import { setTimeout as delay } from 'node:timers/promises'

test('Windows 受限插件探测报告平台限制，不要求安装 Unix 沙箱依赖', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  try {
    const capability = await probePluginSandbox('C:\\missing\\node.exe')
    assert.equal(capability.supported, false)
    assert.match(capability.reason ?? '', /Windows.*尚不支持受限插件/)
    assert.match(capability.reason ?? '', /macOS\/Linux Host/)
    assert.doesNotMatch(capability.reason ?? '', /ENOENT|EPERM|socket|bwrap/)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('受限 external-write 仅普通获准写方法可用，Plan/read-only/full-access声明不能放行', () => {
  const grant = emptyPluginGrant('test')
  grant.restricted.capabilities = ['http.request']
  grant.restricted.network = [{ id: 'write', origin: 'https://example.com', methods: ['POST'] }]
  const operation = { effect: 'external-write', capabilities: ['http.request'] }
  assert.equal(
    allowedRestrictedContribution(operation, { mode: 'default', accessMode: 'workspace-write' }, grant),
    true,
  )
  assert.equal(allowedRestrictedContribution(operation, { mode: 'plan', accessMode: 'full-access' }, grant), false)
  assert.equal(allowedRestrictedContribution(operation, { mode: 'default', accessMode: 'read-only' }, grant), false)
  assert.equal(
    allowedRestrictedContribution(
      { ...operation, effect: 'full-access' },
      { mode: 'default', accessMode: 'full-access' },
      grant,
    ),
    false,
  )
  grant.restricted.network[0].methods = ['GET']
  assert.equal(
    allowedRestrictedContribution(operation, { mode: 'default', accessMode: 'workspace-write' }, grant),
    false,
  )
})

test('受限 Node 真正读取项目，拒绝项目写、秘密、原始网络和派生进程', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-isolation-')))
  const workspace = path.join(root, 'workspace')
  const directory = path.join(root, 'plugin')
  const scratch = path.join(root, 'scratch')
  await Promise.all([mkdir(workspace), mkdir(directory), mkdir(scratch)])
  await writeFile(path.join(root, 'secret'), 'NOT_VISIBLE')
  await writeFile(path.join(workspace, 'visible'), '可读取')
  await writeFile(
    path.join(directory, 'agent.js'),
    `import fs from 'node:fs';import net from 'node:net';import cp from 'node:child_process';
export function activate(ctx){ctx.tools.register({name:'inspect',title:'检查',description:'检查',parameters:{type:'object'},effect:'read',capabilities:[],execute:async()=>{const denied=async f=>{try{await f();return false}catch{return true}};return {text:fs.readFileSync(${JSON.stringify(path.join(workspace, 'visible'))},'utf8'),data:{write:await denied(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'forbidden'))},'bad')),secret:await denied(()=>fs.readFileSync(${JSON.stringify(path.join(root, 'secret'))})),fork:await denied(()=>cp.execFileSync('/usr/bin/true')),network:await denied(()=>new Promise((res,rej)=>{const s=net.connect(1,'127.0.0.1',()=>{s.destroy();res()});s.once('error',rej)}))}}}})}`,
  )
  const runner = new RestrictedRunner({
    node: process.execPath,
    entry: RestrictedRunner.entry,
    workspace,
    directory,
    scratch,
    writable: false,
    launch: pluginSandboxLaunch,
    initialize: { pluginId: 'fixture', generation: 1, agent: path.join(directory, 'agent.js') },
    broker: async () => {
      throw new Error('不应请求broker')
    },
  })
  try {
    const registered = await runner.start()
    assert.equal(registered.tools[0].name, 'inspect')
    const result = (await runner.call(
      'tool',
      { name: 'inspect', parameters: {}, execution: { session: { id: 'test', cwd: workspace }, run: { id: 'run' } } },
      AbortSignal.timeout(5000),
    )) as { text: string; data: Record<string, boolean> }
    assert.equal(result.text, '可读取')
    assert.deepEqual(result.data, { write: true, secret: true, fork: true, network: true })
  } finally {
    await runner.close()
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'macOS 仅放行根目录本身，关闭 Node 权限检查后 OS 仍拒绝越界读写',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-os-boundary-')))
    const workspace = path.join(root, 'workspace')
    const directory = path.join(root, 'plugin')
    const scratch = path.join(root, 'scratch')
    try {
      await Promise.all([mkdir(workspace), mkdir(directory), mkdir(scratch)])
      const secret = path.join(root, 'secret')
      await writeFile(secret, 'FAKE_SECRET')
      const entry = path.join(directory, 'probe.mjs')
      await writeFile(
        entry,
        `import assert from 'node:assert/strict';import fs from 'node:fs';
fs.closeSync(fs.openSync('/', 'r'));
assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)}),/EPERM|EACCES/);
assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'forbidden'))},'bad'),/EPERM|EACCES/);
console.log('OS 边界通过');`,
      )
      const launch = await pluginSandboxLaunch({
        node: process.execPath,
        entry,
        workspace,
        directory,
        scratch,
        writable: false,
      })
      const result = await promisify(execFile)(
        launch.executable,
        launch.args.filter((arg) => arg !== '--permission' && !arg.startsWith('--allow-fs-')),
        { cwd: workspace, env: launch.env, timeout: 5000 },
      )
      assert.match(result.stdout, /OS 边界通过/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('Host 数据根等于工作区拒绝，符号链接数据根嵌在项目内仍实际隐藏秘密', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-host-root-'))
  const workspace = path.join(root, 'project')
  const dataRoot = path.join(workspace, 'host-data')
  const directory = path.join(dataRoot, 'plugins/snapshot')
  const scratch = path.join(root, 'scratch')
  const alias = path.join(root, 'alias')
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(scratch)])
  await symlink(dataRoot, alias)
  const secret = path.join(dataRoot, 'auth.json')
  await writeFile(secret, 'FAKE_HOST_SECRET')
  await writeFile(
    path.join(directory, 'agent.js'),
    `import fs from 'node:fs';export function activate(ctx){ctx.tools.register({name:'secret',title:'秘密',description:'秘密',parameters:{type:'object'},effect:'read',capabilities:[],execute:()=>{let denied=false;try{fs.readFileSync(${JSON.stringify(secret)})}catch{denied=true}return {text:String(denied)}}})}`,
  )
  await writeFile(
    path.join(directory, 'server.js'),
    `export function create(ctx){ctx.registerOperations([{name:'ready',execute:()=> '服务已加载'}])}`,
  )
  const options = {
    node: process.execPath,
    entry: RestrictedRunner.entry,
    workspace,
    directory,
    scratch,
    writable: false,
    dataRoot: alias,
  }
  await assert.rejects(pluginSandboxLaunch({ ...options, workspace: dataRoot }), /应用数据目录/)
  const runner = new RestrictedRunner({
    ...options,
    launch: pluginSandboxLaunch,
    initialize: {
      pluginId: 'secret',
      generation: 1,
      agent: path.join(alias, 'plugins/snapshot/agent.js'),
      server: path.join(alias, 'plugins/snapshot/server.js'),
    },
    broker: async () => null,
  })
  try {
    const registered = await runner.start()
    assert.equal(registered.operations[0].name, 'ready')
    assert.equal(
      await runner.call('server', { operation: 'ready', input: {}, context: {} }, AbortSignal.timeout(5000)),
      '服务已加载',
    )
    const result = (await runner.call(
      'tool',
      { name: 'secret', parameters: {}, execution: {} },
      AbortSignal.timeout(5000),
    )) as { text: string }
    assert.equal(result.text, 'true')
  } finally {
    await runner.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('调用正常结束撤销后台 broker，单次 signal 取消且不杀正常实例，死循环可终止', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-scope-'))
  const workspace = path.join(root, 'workspace')
  const directory = path.join(root, 'plugin')
  const scratch = path.join(root, 'scratch')
  await Promise.all([mkdir(workspace), mkdir(directory), mkdir(scratch)])
  await writeFile(
    path.join(directory, 'agent.js'),
    `export function activate(ctx){let starts=0,ends=0,disposed=0;ctx.hooks.on('sessionStart',()=>{starts++});ctx.hooks.on('sessionEnd',()=>{ends++});ctx.onDispose(()=>{disposed++});const base={title:'测试',description:'测试',parameters:{type:'object'},effect:'read',capabilities:[]};ctx.tools.register({...base,name:'background',execute:()=>{void ctx.http.request({url:'https://example.com',method:'GET'}).catch(()=>{});return {text:'returned'}}});ctx.tools.register({...base,name:'single',execute:async()=>{const c=new AbortController();const p=ctx.http.request({url:'https://example.com',method:'GET'},{signal:c.signal});setTimeout(()=>c.abort(),10);try{await p}catch{return {text:'cancelled'}}return {text:'unexpected'}}});ctx.tools.register({...base,name:'lifecycle',execute:()=>({text:JSON.stringify({starts,ends,disposed})})});ctx.tools.register({...base,name:'hang',execute:()=>{while(true){}}})}`,
  )
  let aborted = 0
  const runner = new RestrictedRunner({
    node: process.execPath,
    entry: RestrictedRunner.entry,
    workspace,
    directory,
    scratch,
    writable: false,
    launch: pluginSandboxLaunch,
    initialize: { pluginId: 'scope', generation: 1, agent: path.join(directory, 'agent.js') },
    broker: async (_method, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted++
            reject(new Error('cancelled'))
          },
          { once: true },
        )
      }),
  })
  try {
    await runner.start()
    await runner.call('hook', { name: 'sessionStart', event: {} }, AbortSignal.timeout(2000))
    const lifecycle = (await runner.call(
      'tool',
      { name: 'lifecycle', parameters: {}, execution: {} },
      AbortSignal.timeout(2000),
    )) as { text: string }
    assert.deepEqual(JSON.parse(lifecycle.text), { starts: 1, ends: 0, disposed: 0 })
    await runner.call('hook', { name: 'sessionEnd', event: {} }, AbortSignal.timeout(2000))
    const cleaned = (await runner.call(
      'tool',
      { name: 'lifecycle', parameters: {}, execution: {} },
      AbortSignal.timeout(2000),
    )) as { text: string }
    assert.deepEqual(JSON.parse(cleaned.text), { starts: 1, ends: 1, disposed: 1 })
    const first = (await runner.call(
      'tool',
      { name: 'background', parameters: {}, execution: {} },
      AbortSignal.timeout(2000),
    )) as { text: string }
    assert.equal(first.text, 'returned')
    assert.equal(aborted, 1)
    const second = (await runner.call(
      'tool',
      { name: 'single', parameters: {}, execution: {} },
      AbortSignal.timeout(2000),
    )) as { text: string }
    assert.equal(second.text, 'cancelled')
    assert.equal(aborted, 2)
    await assert.rejects(
      runner.call('tool', { name: 'hang', parameters: {}, execution: {} }, AbortSignal.timeout(100)),
      /cancelled/,
    )
    await runner.close()
    await assert.rejects(
      runner.call('tool', { name: 'background', parameters: {}, execution: {} }, AbortSignal.timeout(100)),
      /scope-expired/,
    )
  } finally {
    await runner.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('伪造或超大私有协议帧只关闭该受限实例，不调用 Host broker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-protocol-'))
  const workspace = path.join(root, 'workspace')
  const directory = path.join(root, 'plugin')
  const scratch = path.join(root, 'scratch')
  await Promise.all([mkdir(workspace), mkdir(directory), mkdir(scratch)])
  let calls = 0
  try {
    for (const malformed of [true, false]) {
      await writeFile(
        path.join(directory, 'agent.js'),
        `import fs from 'node:fs';export function activate(ctx){ctx.tools.register({name:'bad',title:'坏帧',description:'坏帧',parameters:{type:'object'},effect:'read',capabilities:[],execute:()=>{const body=Buffer.from(JSON.stringify({type:'broker',id:{bad:true},scope:'x',method:'http',input:{}}));const h=Buffer.alloc(4);h.writeUInt32BE(${malformed ? 'body.length' : '4194305'});fs.writeSync(5,${malformed ? 'Buffer.concat([h,body])' : 'h'});return {text:'bad'}}})}`,
      )
      const runner = new RestrictedRunner({
        node: process.execPath,
        entry: RestrictedRunner.entry,
        workspace,
        directory,
        scratch,
        writable: false,
        launch: pluginSandboxLaunch,
        initialize: { pluginId: 'bad', generation: 1, agent: path.join(directory, 'agent.js') },
        broker: async () => {
          calls++
          return null
        },
      })
      try {
        await runner.start()
        await assert.rejects(
          runner.call('tool', { name: 'bad', parameters: {}, execution: {} }, AbortSignal.timeout(2000)),
          /invalid-output|payload-too-large/,
        )
      } finally {
        await runner.close()
      }
    }
    assert.equal(calls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Plan 真实 Host/Worker 调受限 Agent 与同代 Server，项目写入被 OS 拒绝', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-plan-host-'))
  const fake = await useFakeAgent(root, {
    reply: (_body, index) => (index === 1 ? { tool: { name: 'restricted_lookup', arguments: '{}' } } : '检索完成'),
  })
  const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
  try {
    const source = path.join(root, 'plugin')
    await mkdir(path.join(source, 'dist'), { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'restricted-fixture',
        version: '1.0.0',
        type: 'module',
        piMeme: {
          sdkVersion: 3,
          agent: { restricted: 'dist/agent.js' },
          server: { restricted: 'dist/server.js', trusted: 'dist/trusted-server/chord-facets.json' },
          permissions: {
            restricted: {
              maxAccess: 'read-only',
              capabilities: ['workspace.read', 'sharedData.read'],
              sharedData: ['catalog'],
            },
          },
        },
      }),
    )
    await writeFile(
      path.join(source, 'dist/agent.js'),
      `export function activate(ctx){let starts=0;let noBroker=false;ctx.hooks.on('sessionStart',async()=>{starts++;try{await ctx.http.request({url:'https://example.com',method:'GET'})}catch(error){noBroker=String(error).includes('scope-expired')}});ctx.tools.register({name:'restricted_lookup',title:'受限检索',description:'只读检索',parameters:{type:'object'},effect:'read',capabilities:['workspace.read'],execute:async()=>{await ctx.messages.emit({type:'lookup-note',text:'受限消息',data:{ok:true}});await ctx.interaction.notify('受限检索开始');await ctx.interaction.setStatus('lookup','已开始');let internalDenied=false;try{await ctx.messages.emit({type:'pi-meme-collaboration',text:'BAD_INTERNAL'})}catch{internalDenied=true}const c=new AbortController();let rpcCancelled=false;const pending=ctx.server.call('cancel',{}, {signal:c.signal});setTimeout(()=>c.abort(),10);try{await pending}catch(error){rpcCancelled=String(error).includes('cancelled')}return {text:JSON.stringify({starts,noBroker,internalDenied,rpcCancelled,result:await ctx.server.call('lookup',{})})}}})}`,
    )
    await writeFile(
      path.join(source, 'dist/server.js'),
      `import fs from 'node:fs';export function create(ctx){let serverCancelled=0;ctx.registerOperations([{name:'cancel',inputSchema:{type:'object'},outputSchema:{type:'string'},audience:['agent'],effect:'read',capabilities:['workspace.read'],execute:(_input,scope)=>new Promise((_resolve,reject)=>scope.signal.addEventListener('abort',()=>{serverCancelled++;reject(new Error('cancelled'))},{once:true}))},{name:'lookup',inputSchema:{type:'object'},outputSchema:{type:'string'},audience:['agent'],effect:'read',capabilities:['workspace.read'],execute:async()=>{let denied=false;try{fs.writeFileSync('forbidden.txt','bad')}catch{denied=true}const catalog=await ctx.sharedData.read('catalog');let sharedDenied=false,trustedDenied=false;try{await ctx.sharedData.read('private')}catch{sharedDenied=true}try{await ctx.server.call('trusted-only',{})}catch{trustedDenied=true}return JSON.stringify({denied,serverCancelled,sharedDenied,trustedDenied,catalog:catalog.value,files:fs.readdirSync('.')})}}])}`,
    )
    const trusted = path.join(source, 'trusted.ts')
    await writeFile(
      trusted,
      `import {defineFacet,defineService} from '@earendil-works/chord';export default defineFacet({id:'shared-provider',setup(env){env.provide(defineService('pi-meme.plugin.module:restricted-fixture',{local:true}),{create:async(ctx)=>{await ctx.sharedData.publish('catalog',{title:'PUBLISHED_CATALOG'},{expectedRevision:0});ctx.registerOperations([{name:'trusted-only',inputSchema:{type:'object'},outputSchema:{type:'string'},audience:['agent'],effect:'read',capabilities:[],execute:()=> 'MUST_NOT_RUN'}])}})}})`,
    )
    await bundleFacets({
      plugin: { id: 'restricted-fixture', version: '1.0.0' },
      entries: { server: trusted },
      outdir: path.join(source, 'dist/trusted-server'),
    })
    const installed = await host.plugins.loadDirectory(source)
    await host.plugins.setGrant(installed.id, {
      ...installed.grant!,
      trusted: { ui: false, server: true, agent: false },
      expectedRevision: installed.grant!.revision,
      policyHash: installed.policyHash!,
      restricted: {
        maxAccess: 'read-only',
        capabilities: ['workspace.read', 'sharedData.read'],
        sharedData: ['catalog'],
      },
    })
    const initial = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'plan-fixture',
      method: 'pi:snapshot',
      args: [],
    })
    assert.equal(initial.error, undefined)
    const snapshot = initial.result as import('@pi-meme/contracts/desktop').Snapshot
    const session = await host.control.sessionForRuntime(snapshot.connection.sessionKey!)
    await host.app.sessions.configure(
      session,
      { agentPlugins: [installed.id], model: { provider: 'fake', id: 'first' }, mode: 'plan' },
      { idempotencyKey: crypto.randomUUID() },
    )
    const submission = await host.app.sessions.submit(
      session,
      { delivery: 'start', text: '使用 restricted_lookup 检索', mode: 'plan' },
      { idempotencyKey: crypto.randomUUID() },
    )
    let receipt = await host.app.sessions.receipt(submission.operationId)
    for (let i = 0; i < 400 && !['completed', 'failed', 'cancelled'].includes(receipt.status); i++) {
      await delay(25)
      receipt = await host.app.sessions.receipt(submission.operationId)
    }
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt))
    const after = await host.app.sessions.snapshot(session)
    const result = after.messages.find((m) => m.role === 'toolResult' && m.toolName === 'restricted_lookup')
    assert.ok(result && result.role === 'toolResult', JSON.stringify(after.messages))
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.match(JSON.stringify(result.content), /denied.*true/)
    assert.match(JSON.stringify(result.content), /starts.*1/)
    assert.match(JSON.stringify(result.content), /noBroker.*true/)
    assert.match(JSON.stringify(result.content), /rpcCancelled.*true/)
    assert.match(JSON.stringify(result.content), /serverCancelled.*1/)
    assert.match(JSON.stringify(result.content), /PUBLISHED_CATALOG/)
    assert.match(JSON.stringify(result.content), /sharedDenied.*true/)
    assert.match(JSON.stringify(result.content), /trustedDenied.*true/)
    assert.doesNotMatch(JSON.stringify(result.content), /MUST_NOT_RUN/)
    assert.match(JSON.stringify(result.content), /internalDenied.*true/)
    assert.equal(result.source?.ownerId, installed.id)
    const custom = after.messages.find((message) => message.role === 'custom' && message.customType === 'lookup-note')
    assert.equal(custom?.source?.ownerId, installed.id)
    assert.ok(custom?.sourceEntry)
    assert.doesNotMatch(JSON.stringify(after.messages), /BAD_INTERNAL/)
    assert.ok(after.state.pluginPolicy?.effectivePlugins.some((p) => p.id === installed.id))
  } finally {
    await host.dispose()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['grant', 'disable', 'remove'] as const)(
  '真实运行 %s 先终止不结束工具和 Worker，不等待普通更新 drain',
  { timeout: 20000 },
  async (action) => {
    const root = await mkdtemp(path.join(tmpdir(), 'plugin-revoke-'))
    const fake = await useFakeAgent(root, { reply: () => ({ tool: { name: 'restricted_wait', arguments: '{}' } }) })
    const host = await createHost({ dataRoot: fake.runtimePaths.dataRoot, credentials: fake.credentials })
    let off: (() => void) | undefined
    try {
      const source = path.join(root, 'plugin')
      await mkdir(path.join(source, 'dist'), { recursive: true })
      await writeFile(
        path.join(source, 'package.json'),
        JSON.stringify({
          name: 'revoke-fixture',
          version: '1.0.0',
          type: 'module',
          piMeme: {
            sdkVersion: 3,
            agent: { restricted: 'dist/agent.js' },
            server: { trusted: 'dist/trusted-server/chord-facets.json' },
            ui: 'dist/ui.js',
            permissions: { restricted: { maxAccess: 'read-only', capabilities: ['workspace.read'] } },
          },
        }),
      )
      await writeFile(
        path.join(source, 'dist/agent.js'),
        `export function activate(ctx){ctx.tools.register({name:'restricted_wait',title:'等待',description:'等待撤权',parameters:{type:'object'},effect:'read',capabilities:['workspace.read'],execute:()=>new Promise(()=>{})})}`,
      )
      const trusted = path.join(source, 'trusted.ts')
      await writeFile(
        trusted,
        `import {defineFacet,defineService} from '@earendil-works/chord';export default defineFacet({id:'revocation-server',setup(env){env.provide(defineService('pi-meme.plugin.module:revoke-fixture',{local:true}),{create(){}})}})`,
      )
      await writeFile(path.join(source, 'dist/ui.js'), 'export {}')
      await bundleFacets({
        plugin: { id: 'revoke-fixture', version: '1.0.0' },
        entries: { server: trusted },
        outdir: path.join(source, 'dist/trusted-server'),
      })
      const installed = await host.plugins.loadDirectory(source)
      await host.plugins.setGrant(installed.id, {
        ...installed.grant!,
        trusted: { ui: true, server: true, agent: false },
        expectedRevision: installed.grant!.revision,
        policyHash: installed.policyHash!,
        restricted: { maxAccess: 'read-only', capabilities: ['workspace.read'] },
      })
      const initial = await host.rpc({
        requestId: crypto.randomUUID(),
        clientId: 'revoke-fixture',
        method: 'pi:snapshot',
        args: [],
      })
      assert.equal(initial.error, undefined)
      const snapshot = initial.result as import('@pi-meme/contracts/desktop').Snapshot
      const session = await host.control.sessionForRuntime(snapshot.connection.sessionKey!)
      await host.app.sessions.configure(
        session,
        { agentPlugins: [installed.id], model: { provider: 'fake', id: 'first' }, mode: 'default' },
        { idempotencyKey: crypto.randomUUID() },
      )
      let entered = false
      const events: DesktopEvent[] = []
      off = await host.subscribe('revoke-fixture', (event) => {
        if (event.type === 'event') events.push(event.value)
        if (
          event.type === 'event' &&
          event.value.event.type === 'tool_execution_start' &&
          event.value.event.toolName === 'restricted_wait'
        )
          entered = true
      })
      await host.app.sessions.submit(
        session,
        { delivery: 'start', text: '调用 restricted_wait' },
        { idempotencyKey: crypto.randomUUID() },
      )
      for (let i = 0; i < 200; i++) {
        if (entered) break
        await delay(20)
      }
      assert.equal(entered, true)
      await delay(50)
      const current = host.plugins.list().find((p) => p.id === installed.id)!
      const dirty = host.plugins.acquireUiLease('revoke-fixture', {
        pluginId: installed.id,
        generation: current.generation,
        routeInstance: action,
      })
      const revocation =
        action === 'disable'
          ? host.plugins.disable(installed.id)
          : action === 'remove'
            ? host.plugins.remove(installed.id)
            : host.plugins.setGrant(installed.id, {
                ...current.grant!,
                expectedRevision: current.grant!.revision,
                policyHash: current.policyHash!,
                restricted: { maxAccess: 'read-only', capabilities: [] },
              })
      await Promise.resolve()
      const changing = host.plugins.list().find((p) => p.id === installed.id)!
      const oldGrantCurrent = host.plugins.isGrantCurrent(installed.id, current.generation, current.grant!.revision)
      const timeout = AbortSignal.timeout(5000)
      await Promise.race([
        revocation,
        new Promise<never>((_resolve, reject) =>
          timeout.addEventListener('abort', () => reject(new Error('撤权等待了不结束的工具')), { once: true }),
        ),
      ])
      assert.equal(changing.grantChanging, true)
      assert.deepEqual(changing.grant, current.grant)
      assert.equal(oldGrantCurrent, false)
      assert.equal(host.plugins.isGrantCurrent(installed.id, current.generation, current.grant!.revision), false)
      assert.throws(() => host.plugins.renewUiLease('revoke-fixture', dirty.id), /scope-expired/)
      const started = events.find((value) => value.event.type === 'tool_execution_start')!
      const settled = events.filter((value) => value.event.type === 'agent_settled')
      assert.equal(settled.length, 1)
      assert.equal(settled[0]!.executionGeneration, started.executionGeneration)
      assert.equal(settled[0]!.event.type === 'agent_settled' && settled[0]!.event.aborted, true)
      const after = await host.app.sessions.snapshot(session)
      assert.equal(after.connection.status, 'idle')
      assert.equal(after.state.isStreaming, false)
      assert.ok(after.state.runIntervals?.at(-1)?.endedAt)
      assert.equal(after.messages.filter((message) => message.role === 'user').length, 1)
      assert.equal(
        events
          .slice(events.indexOf(settled[0]!) + 1)
          .some((value) => ['agent_start', 'message_update', 'tool_execution_start'].includes(value.event.type)),
        false,
      )
      if (action === 'grant')
        assert.ok(host.plugins.list().find((p) => p.id === installed.id)!.grant!.revision > current.grant!.revision)
      else if (action === 'disable')
        assert.equal(host.plugins.list().find((p) => p.id === installed.id)!.enabled, false)
      else
        assert.equal(
          host.plugins.list().some((p) => p.id === installed.id),
          false,
        )
    } finally {
      off?.()
      await host.dispose()
      await fake.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
