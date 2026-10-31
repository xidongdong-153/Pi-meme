import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { pluginSandboxLaunch } from './plugin-sandbox'
import { spawnWindowsProcess, WindowsCommandProcess } from '@pi-meme/windows-native/process'

export type PluginSandboxCapability = { supported: boolean; reason?: string }
const probes = new Map<string, Promise<PluginSandboxCapability>>()
export function probePluginSandbox(node: string): Promise<PluginSandboxCapability> {
  if (!['darwin', 'linux', 'win32'].includes(process.platform))
    return Promise.resolve({
      supported: false,
      reason: `当前平台不支持受限插件：${process.platform}`,
    })
  const key = `${process.platform}:${process.arch}:${node}`
  let pending = probes.get(key)
  if (!pending) {
    pending = probe(node)
    probes.set(key, pending)
  }
  return pending
}
async function probe(node: string): Promise<PluginSandboxCapability> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-plugin-probe-'))
  const tcp = createServer((socket) => socket.destroy())
  const unix = createServer((socket) => socket.destroy())
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\pi-meme-plugin-probe-${path.basename(root)}`
      : path.join(root, 'workspace/socket')
  try {
    const workspace = path.join(root, 'workspace')
    const directory = path.join(root, 'plugin')
    const scratch = path.join(root, 'scratch')
    await Promise.all([mkdir(workspace), mkdir(directory), mkdir(scratch)])
    await writeFile(path.join(root, 'private'), 'fake-secret')
    await writeFile(path.join(workspace, 'read'), 'readable')
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(0, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) => {
      unix.once('error', reject)
      unix.listen(socketPath, resolve)
    })
    const address = tcp.address()
    if (!address || typeof address === 'string') throw new Error('沙箱探测端口不可用')
    const entry = path.join(directory, 'probe.mjs')
    await writeFile(
      entry,
      `import fs from 'node:fs';import net from 'node:net';import cp from 'node:child_process';const denied=async fn=>{try{await fn();return false}catch{return true}};const socket=(value)=>new Promise((resolve,reject)=>{const s=net.connect(value,()=>{s.destroy();resolve()});s.once('error',error=>${process.platform === 'win32' ? "['EACCES','EPERM'].includes(error.code)?reject(error):resolve()" : 'reject(error)'});s.setTimeout(500,()=>{s.destroy();resolve()})});console.log(JSON.stringify({read:fs.readFileSync('read','utf8')==='readable',writeDenied:await denied(()=>fs.writeFileSync('write','allowed')),outside:await denied(()=>fs.readFileSync(${JSON.stringify(path.join(root, 'private'))})),tcp:await denied(()=>socket({host:'127.0.0.1',port:${address.port}})),unix:await denied(()=>socket(${JSON.stringify(socketPath)})),fork:await denied(()=>cp.execFileSync(${JSON.stringify(node)},['-e','process.exit(0)'])),env:!process.env.PI_MEME_DATA_ROOT&&!process.env.SSH_AUTH_SOCK&&!process.env.NODE_OPTIONS}));`,
    )
    for (const writable of [true, false]) {
      const launch = await pluginSandboxLaunch({ node, entry, workspace, directory, scratch, writable })
      // Windows 探测不带 Node 权限参数，逐项核对原生隔离。
      const native = launch.windowsSandbox
        ? await spawnWindowsProcess(launch.executable, [entry], {
            env: launch.env,
            cwd: workspace,
            sandbox: launch.windowsSandbox,
          })
        : undefined
      const result = await new Promise<string>((resolve, reject) => {
        const child = native
          ? new WindowsCommandProcess(native)
          : spawn(launch.executable, launch.args, {
              env: launch.env,
              cwd: workspace,
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            })
        let output = ''
        let error = ''
        const timer = setTimeout(() => {
          if (child instanceof WindowsCommandProcess) {
            child.native.kill()
            return
          }
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }
        }, 5000)
        child.stdout!.on('data', (b: Buffer) => {
          output = (output + b.toString()).slice(-65536)
        })
        child.stderr!.on('data', (b: Buffer) => {
          error = (error + b.toString()).slice(-2048)
        })
        if (child instanceof WindowsCommandProcess) child.stdin.end()
        else {
          const fd = child.stdio[3] as Writable
          fd.on('error', () => {})
          fd.end(launch.seccomp)
        }
        child.once('error', (cause) => {
          clearTimeout(timer)
          reject(cause)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve(output)
          else reject(new Error(`受限 Node 探测退出 ${code}：${error}`))
        })
      })
      const value = JSON.parse(result) as Record<string, boolean>
      if (
        !value.read ||
        value.writeDenied !== !writable ||
        !value.outside ||
        !value.tcp ||
        !value.unix ||
        !value.fork ||
        !value.env
      )
        throw new Error(`受限进程读写、秘密、网络或进程边界探测失败：${JSON.stringify(value)}`)
      if (writable && (await readFile(path.join(workspace, 'write'), 'utf8')) !== 'allowed')
        throw new Error('受限工作区写入探测失败')
    }
    return { supported: true }
  } catch (cause) {
    return { supported: false, reason: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => tcp.close(() => resolve())),
      new Promise<void>((resolve) => unix.close(() => resolve())),
    ])
    await rm(root, { recursive: true, force: true })
  }
}
