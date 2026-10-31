import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { spawnWindowsProcess } from '../src/process'
import { windowsRuntimeReadPaths, windowsSandboxEnvironment } from '../src/sandbox'

test(
  'Windows PSEC 原生拒绝越界文件、网络和派生进程',
  { skip: process.platform !== 'win32', timeout: 20000 },
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-native-plugin-')))
    const workspace = path.join(root, 'workspace')
    const scratch = path.join(root, 'scratch')
    const directory = path.join(root, 'plugin')
    await Promise.all([mkdir(workspace), mkdir(scratch), mkdir(directory)])
    await writeFile(path.join(root, 'secret'), 'secret')
    await promisify(execFile)('icacls.exe', [path.join(root, 'secret'), '/grant', '*S-1-1-0:F'], { windowsHide: true })
    await writeFile(path.join(workspace, 'read'), 'readable')
    const node = await realpath(
      process.env.PI_MEME_PLUGIN_NODE || path.resolve('out/release-resources/desktop/runtime/bin/node.exe'),
    )
    const entry = path.join(directory, 'probe.mjs')
    await writeFile(
      entry,
      `import fs from 'node:fs';import net from 'node:net';import cp from 'node:child_process';const denied=async fn=>{try{await fn();return false}catch{return true}};const result={env:!process.env.PI_MEME_FAKE_SECRET&&!process.env.NODE_OPTIONS&&!process.env.NODE_PATH,read:fs.readFileSync(${JSON.stringify(path.join(workspace, 'read'))},'utf8')==='readable',writeDenied:await denied(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'write'))},'bad')),outside:await denied(()=>fs.readFileSync(${JSON.stringify(path.join(root, 'secret'))})),outsideWrite:await denied(()=>fs.writeFileSync(${JSON.stringify(path.join(root, 'secret'))},'bad')),link:await denied(()=>fs.linkSync(${JSON.stringify(path.join(workspace, 'read'))},${JSON.stringify(path.join(scratch, 'alias'))})),fork:await denied(()=>cp.execFileSync(${JSON.stringify(node)},['-e','process.exit(0)'])),tcp:await denied(()=>new Promise((resolve,reject)=>{const s=net.connect(9,'127.0.0.1',()=>{s.destroy();resolve()});s.once('error',error=>{if(error.code==='EACCES'||error.code==='EPERM')reject(error);else resolve()})}))};fs.writeFileSync(${JSON.stringify(path.join(scratch, 'allowed'))},'allowed');console.log(JSON.stringify(result))`,
    )
    try {
      const child = await spawnWindowsProcess(node, [entry], {
        cwd: workspace,
        env: windowsSandboxEnvironment(scratch, {
          PI_MEME_FAKE_SECRET: 'fake',
          NODE_OPTIONS: '--invalid-native-option',
          NODE_PATH: root,
        }),
        sandbox: {
          read: [node, directory, workspace, ...(await windowsRuntimeReadPaths(node))],
          write: [scratch],
          deny: [],
          allowNetwork: false,
          allowChildren: false,
        },
      })
      let output = ''
      let error = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        error += chunk.toString()
      })
      child.stdin.end()
      assert.equal((await child.completion).exitCode, 0, error)
      assert.deepEqual(JSON.parse(output), {
        env: true,
        read: true,
        writeDenied: true,
        outside: true,
        outsideWrite: true,
        link: true,
        fork: true,
        tcp: true,
      })
      assert.equal(await readFile(path.join(root, 'secret'), 'utf8'), 'secret')
      assert.equal(await readFile(path.join(scratch, 'allowed'), 'utf8'), 'allowed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
